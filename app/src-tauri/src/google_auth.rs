//! Google OAuth 2.0 sign-in (Authorization Code + PKCE, loopback redirect)
//! used solely to reach a hidden per-app folder in the user's own Google
//! Drive (`drive.appdata` scope) where Telegram `api_id`/`api_hash` — and,
//! once the app-lock feature exists, an email+password hash — are synced
//! across devices. This module never touches `grammers_client`,
//! `TelegramState`, or the Telegram session file; Google/Drive access is
//! entirely independent of, and never required for, Telegram login.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;

const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";
const SYNC_FILE_NAME: &str = "telegram-drive-sync.json";
const OAUTH_SCOPES: &str = "openid email profile https://www.googleapis.com/auth/drive.appdata";
const OAUTH_TIMEOUT_SECS: u64 = 300;

// Baked-in default OAuth client (this app's own Google Cloud "Desktop app"
// client — loopback redirect, no secret exposure risk beyond what's already
// inherent to a public/installed-app OAuth client type). Compiled in so a
// fresh install, reinstall, or wiped app-data folder never falls back to
// asking for these again — `load_auth` fills them in whenever the saved
// file has none. Settings can still override with different values.
const DEFAULT_CLIENT_ID: &str =
    "729387503097-2d1ru3o58afem460hgk11s5vq5kjiohf.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET: &str = "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";

// ---------------------------------------------------------------------------
// Persisted settings (client id/secret + refresh token) — same *File/*Response
// split, atomic-write pattern as commands/webdav_settings.rs.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GoogleAuthFile {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub refresh_token: Option<String>,
    pub account_email: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct GoogleAccountResponse {
    pub account_email: Option<String>,
    pub connected: bool,
    pub client_configured: bool,
    // Returned so Settings can show what's already saved instead of always
    // presenting a blank "one-time setup" form — this is a single-user local
    // desktop app, so redisplaying it here is a usability win, not a leak.
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("google_auth.json"))
}

pub fn load_auth(app: &AppHandle) -> GoogleAuthFile {
    let mut auth: GoogleAuthFile = settings_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default();
    // Never a blank slate: if nothing was ever saved (or the file went
    // missing after a reinstall), fall back to the built-in client instead
    // of prompting for setup again.
    if auth.client_id.is_none() {
        auth.client_id = Some(DEFAULT_CLIENT_ID.to_string());
    }
    if auth.client_secret.is_none() {
        auth.client_secret = Some(DEFAULT_CLIENT_SECRET.to_string());
    }
    auth
}

pub fn save_auth(app: &AppHandle, auth: &GoogleAuthFile) -> Result<(), String> {
    let path = settings_path(app)?;
    let temp_path = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(auth).map_err(|error| error.to_string())?;
    std::fs::write(&temp_path, contents).map_err(|error| error.to_string())?;
    if std::fs::rename(&temp_path, &path).is_ok() {
        return Ok(());
    }
    std::fs::copy(&temp_path, &path).map_err(|error| error.to_string())?;
    std::fs::remove_file(&temp_path).map_err(|error| error.to_string())
}

pub fn account_response(app: &AppHandle) -> GoogleAccountResponse {
    let auth = load_auth(app);
    GoogleAccountResponse {
        connected: auth.refresh_token.is_some(),
        account_email: auth.account_email,
        client_configured: auth.client_id.is_some() && auth.client_secret.is_some(),
        client_id: auth.client_id,
        client_secret: auth.client_secret,
    }
}

pub fn sign_out(app: &AppHandle) -> Result<(), String> {
    let mut auth = load_auth(app);
    auth.refresh_token = None;
    auth.account_email = None;
    save_auth(app, &auth)
}

// ---------------------------------------------------------------------------
// PKCE / CSRF-state helpers
// ---------------------------------------------------------------------------

fn random_url_safe(byte_len: usize) -> String {
    let mut bytes = vec![0u8; byte_len];
    rand::RngCore::fill_bytes(&mut rand::rng(), &mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

// ---------------------------------------------------------------------------
// Loopback OAuth flow state machine
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub enum GoogleOAuthOutcome {
    Success { account_email: String },
    Failed(String),
    TimedOut,
    Cancelled,
}

#[derive(Default)]
pub struct GoogleOAuthInner {
    outcome: Option<GoogleOAuthOutcome>,
    cancel_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

pub struct GoogleOAuthState {
    inner: StdMutex<GoogleOAuthInner>,
}

impl GoogleOAuthState {
    pub fn new() -> Self {
        Self { inner: StdMutex::new(GoogleOAuthInner::default()) }
    }
}

impl Default for GoogleOAuthState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize, Clone)]
pub struct GoogleOAuthPollResult {
    pub done: bool,
    pub success: bool,
    pub account_email: Option<String>,
    pub error: Option<String>,
}

/// Starts a new OAuth attempt: binds an OS-assigned loopback port (Google's
/// "Desktop app" client type accepts any `127.0.0.1` port without
/// pre-registration, so there is nothing to collide with), builds the
/// consent URL, and spawns a background task that waits for exactly one
/// redirect. Returns the URL for the frontend to open in the system browser.
pub async fn start_oauth_flow(app: AppHandle) -> Result<String, String> {
    let auth = load_auth(&app);
    let client_id = auth
        .client_id
        .clone()
        .ok_or_else(|| "Set your Google Client ID and Secret in Settings first.".to_string())?;
    if auth.client_secret.is_none() {
        return Err("Set your Google Client ID and Secret in Settings first.".to_string());
    }

    {
        let state = app.state::<GoogleOAuthState>();
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Google OAuth state lock was poisoned".to_string())?;
        if let Some(tx) = inner.cancel_tx.take() {
            let _ = tx.send(());
        }
        inner.outcome = None;
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Failed to start local OAuth listener: {}", error))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    let code_verifier = random_url_safe(64);
    let challenge = code_challenge(&code_verifier);
    let state_token = random_url_safe(24);

    let authorize_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        AUTHORIZE_URL,
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(OAUTH_SCOPES),
        urlencoding::encode(&state_token),
        urlencoding::encode(&challenge),
    );

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    {
        let state = app.state::<GoogleOAuthState>();
        state
            .inner
            .lock()
            .map_err(|_| "Google OAuth state lock was poisoned".to_string())?
            .cancel_tx = Some(cancel_tx);
    }

    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome =
            run_oauth_listener(&app_for_task, listener, state_token, code_verifier, redirect_uri, cancel_rx)
                .await;
        if let Some(oauth_state) = app_for_task.try_state::<GoogleOAuthState>() {
            if let Ok(mut inner) = oauth_state.inner.lock() {
                inner.outcome = Some(outcome);
                inner.cancel_tx = None;
            }
        }
    });

    Ok(authorize_url)
}

async fn run_oauth_listener(
    app: &AppHandle,
    listener: TcpListener,
    expected_state: String,
    code_verifier: String,
    redirect_uri: String,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> GoogleOAuthOutcome {
    tokio::select! {
        result = accept_and_parse(&listener) => {
            match result {
                Ok((code, state_param)) => {
                    if !constant_time_eq::constant_time_eq(state_param.as_bytes(), expected_state.as_bytes()) {
                        GoogleOAuthOutcome::Failed(
                            "Login attempt could not be verified (state mismatch) — please try again.".to_string(),
                        )
                    } else {
                        match complete_token_exchange(app, &code, &code_verifier, &redirect_uri).await {
                            Ok(email) => GoogleOAuthOutcome::Success { account_email: email },
                            Err(error) => GoogleOAuthOutcome::Failed(error),
                        }
                    }
                }
                Err(error) => GoogleOAuthOutcome::Failed(error),
            }
        }
        _ = tokio::time::sleep(Duration::from_secs(OAUTH_TIMEOUT_SECS)) => GoogleOAuthOutcome::TimedOut,
        _ = &mut cancel_rx => GoogleOAuthOutcome::Cancelled,
    }
}

/// Accepts exactly one HTTP connection, extracts `code`/`state`/`error` from
/// the request's query string, replies with a static (never-reflecting)
/// HTML page, and closes the socket.
async fn accept_and_parse(listener: &TcpListener) -> Result<(String, String), String> {
    let (mut socket, _) = listener.accept().await.map_err(|error| error.to_string())?;
    let mut buf = vec![0u8; 8192];
    let bytes_read = socket
        .read(&mut buf)
        .await
        .map_err(|error| error.to_string())?;
    let request = String::from_utf8_lossy(&buf[..bytes_read]).into_owned();

    let body = "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:4rem;color:#333;\">\
        You can close this tab and return to Telegram Drive.</body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;

    let (code, state_param, error) = parse_callback_request(&request);
    if let Some(error) = error {
        return Err(format!("Google returned an error: {}", error));
    }
    let code = code.ok_or_else(|| "No authorization code in redirect".to_string())?;
    let state_param = state_param.ok_or_else(|| "No state in redirect".to_string())?;
    Ok((code, state_param))
}

/// Pure parsing of the raw HTTP request text into `(code, state, error)` —
/// split out from `accept_and_parse` so it's unit-testable without a real
/// socket.
fn parse_callback_request(request: &str) -> (Option<String>, Option<String>, Option<String>) {
    let first_line = request.lines().next().unwrap_or("");
    let path_and_query = first_line.split_whitespace().nth(1).unwrap_or("");
    let query = path_and_query.split_once('?').map(|(_, q)| q).unwrap_or("");

    let mut code = None;
    let mut state_param = None;
    let mut error = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let decoded = urlencoding::decode(value)
            .map(|cow| cow.into_owned())
            .unwrap_or_else(|_| value.to_string());
        match key {
            "code" => code = Some(decoded),
            "state" => state_param = Some(decoded),
            "error" => error = Some(decoded),
            _ => {}
        }
    }
    (code, state_param, error)
}

pub fn poll_oauth_flow(app: &AppHandle) -> Result<GoogleOAuthPollResult, String> {
    let state = app.state::<GoogleOAuthState>();
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Google OAuth state lock was poisoned".to_string())?;
    Ok(match inner.outcome.take() {
        None => GoogleOAuthPollResult { done: false, success: false, account_email: None, error: None },
        Some(GoogleOAuthOutcome::Success { account_email }) => {
            GoogleOAuthPollResult { done: true, success: true, account_email: Some(account_email), error: None }
        }
        Some(GoogleOAuthOutcome::Failed(message)) => {
            GoogleOAuthPollResult { done: true, success: false, account_email: None, error: Some(message) }
        }
        Some(GoogleOAuthOutcome::TimedOut) => GoogleOAuthPollResult {
            done: true,
            success: false,
            account_email: None,
            error: Some("Timed out waiting for Google sign-in.".to_string()),
        },
        Some(GoogleOAuthOutcome::Cancelled) => {
            GoogleOAuthPollResult { done: true, success: false, account_email: None, error: Some("Cancelled.".to_string()) }
        }
    })
}

pub fn cancel_oauth_flow(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<GoogleOAuthState>();
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Google OAuth state lock was poisoned".to_string())?;
    if let Some(tx) = inner.cancel_tx.take() {
        let _ = tx.send(());
    }
    inner.outcome = Some(GoogleOAuthOutcome::Cancelled);
    Ok(())
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

async fn complete_token_exchange(
    app: &AppHandle,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    let mut auth = load_auth(app);
    let client_id = auth.client_id.clone().ok_or("Google Client ID is not configured")?;
    let client_secret = auth.client_secret.clone().ok_or("Google Client Secret is not configured")?;

    let client = reqwest::Client::new();
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code),
            ("code_verifier", code_verifier),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|error| format!("Token exchange request failed: {}", error))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed: {}", body));
    }
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|error| format!("Invalid token response: {}", error))?;

    if token.refresh_token.is_none() && auth.refresh_token.is_none() {
        return Err(
            "Google did not grant offline access, so this account can't be remembered. Please try connecting again."
                .to_string(),
        );
    }

    let userinfo: serde_json::Value = client
        .get(USERINFO_URL)
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let email = userinfo
        .get("email")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();

    if let Some(refresh_token) = token.refresh_token {
        auth.refresh_token = Some(refresh_token);
    }
    auth.account_email = Some(email.clone());
    save_auth(app, &auth)?;
    Ok(email)
}

async fn get_fresh_access_token(app: &AppHandle) -> Result<String, String> {
    let auth = load_auth(app);
    let client_id = auth.client_id.ok_or("Google Client ID is not configured")?;
    let client_secret = auth.client_secret.ok_or("Google Client Secret is not configured")?;
    let refresh_token = auth.refresh_token.ok_or("Google account is not connected")?;

    let client = reqwest::Client::new();
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|error| format!("Token refresh failed: {}", error))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        if body.contains("invalid_grant") {
            // Access was revoked from the Google Account side — clear our
            // stored connection so the UI reflects "disconnected" rather
            // than repeatedly failing silently. Telegram login and the
            // locally-cached app-lock are unaffected.
            let _ = sign_out(app);
            return Err("Google access was revoked. Please reconnect your Google account.".to_string());
        }
        return Err(format!("Token refresh failed: {}", body));
    }
    #[derive(Deserialize)]
    struct RefreshResponse {
        access_token: String,
    }
    let refreshed: RefreshResponse = response.json().await.map_err(|error| error.to_string())?;
    Ok(refreshed.access_token)
}

// ---------------------------------------------------------------------------
// Drive appDataFolder sync
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncAppLock {
    pub email: String,
    pub password_hash: String,
    /// Whether app-lock is currently ON for the device that pushed this.
    /// Defaults to `true` for blobs written before this field existed, so
    /// old data keeps meaning what it always implicitly meant (presence of
    /// this section == enabled) — only new pushes can explicitly say "off".
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// The Telegram session, encrypted client-side with a key derived from the
/// user's TOTP authenticator secret before it ever leaves this device — see
/// `crate::crypto::totp` and `commands::totp`. The secret itself is never
/// part of this blob, so this ciphertext alone (i.e. a compromised Google
/// account) is not enough to recover the session.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncEncryptedSession {
    pub nonce_b64: String,
    pub ciphertext_b64: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct SyncBlob {
    version: u32,
    api_id: Option<String>,
    api_hash: Option<String>,
    app_lock: Option<SyncAppLock>,
    encrypted_session: Option<SyncEncryptedSession>,
    /// Any fields this struct doesn't explicitly model (e.g. mobile's
    /// `shares`). Captured here so a desktop push round-trips them back to
    /// Drive unchanged instead of silently deleting them — see the fix for
    /// the data-loss bug where every desktop push (App Lock, API
    /// credentials, TOTP resync) wiped out mobile-written data desktop
    /// doesn't know about.
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct DriveSyncPullResult {
    pub api_id: Option<String>,
    pub api_hash: Option<String>,
    pub has_app_lock: bool,
    pub app_lock_email: Option<String>,
    pub app_lock_password_hash: Option<String>,
    pub app_lock_enabled: bool,
    pub encrypted_session: Option<SyncEncryptedSession>,
}

#[derive(Deserialize)]
struct DriveFileEntry {
    id: String,
}

#[derive(Deserialize)]
struct DriveListResponse {
    #[serde(default)]
    files: Vec<DriveFileEntry>,
}

async fn find_sync_file_id(client: &reqwest::Client, access_token: &str) -> Result<Option<String>, String> {
    let response = client
        .get(DRIVE_FILES_URL)
        .bearer_auth(access_token)
        .query(&[
            ("spaces", "appDataFolder"),
            ("q", &format!("name='{}'", SYNC_FILE_NAME)),
            ("fields", "files(id)"),
        ])
        .send()
        .await
        .map_err(|error| format!("Drive list request failed: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("Drive list failed: {}", response.text().await.unwrap_or_default()));
    }
    let parsed: DriveListResponse = response.json().await.map_err(|error| error.to_string())?;
    Ok(parsed.files.into_iter().next().map(|entry| entry.id))
}

async fn download_sync_file(
    client: &reqwest::Client,
    access_token: &str,
    file_id: &str,
) -> Result<SyncBlob, String> {
    let response = client
        .get(format!("{}/{}", DRIVE_FILES_URL, file_id))
        .bearer_auth(access_token)
        .query(&[("alt", "media")])
        .send()
        .await
        .map_err(|error| format!("Drive download request failed: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("Drive download failed: {}", response.text().await.unwrap_or_default()));
    }
    let text = response.text().await.map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| format!("The remote sync file is corrupt: {}", error))
}

async fn create_sync_file(client: &reqwest::Client, access_token: &str, blob: &SyncBlob) -> Result<(), String> {
    let metadata = serde_json::json!({ "name": SYNC_FILE_NAME, "parents": ["appDataFolder"] });
    let body_json = serde_json::to_string(blob).map_err(|error| error.to_string())?;

    let metadata_part = reqwest::multipart::Part::text(metadata.to_string())
        .mime_str("application/json; charset=UTF-8")
        .map_err(|error| error.to_string())?;
    let media_part = reqwest::multipart::Part::text(body_json)
        .mime_str("application/json")
        .map_err(|error| error.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("metadata", metadata_part)
        .part("media", media_part);

    let response = client
        .post(format!("{}?uploadType=multipart", DRIVE_UPLOAD_URL))
        .bearer_auth(access_token)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("Drive create request failed: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("Drive create failed: {}", response.text().await.unwrap_or_default()));
    }
    Ok(())
}

async fn update_sync_file(
    client: &reqwest::Client,
    access_token: &str,
    file_id: &str,
    blob: &SyncBlob,
) -> Result<(), String> {
    let body_json = serde_json::to_string(blob).map_err(|error| error.to_string())?;
    let response = client
        .patch(format!("{}/{}?uploadType=media", DRIVE_UPLOAD_URL, file_id))
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
        .body(body_json)
        .send()
        .await
        .map_err(|error| format!("Drive update request failed: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("Drive update failed: {}", response.text().await.unwrap_or_default()));
    }
    Ok(())
}

pub async fn drive_sync_pull(app: &AppHandle) -> Result<DriveSyncPullResult, String> {
    let access_token = get_fresh_access_token(app).await?;
    let client = reqwest::Client::new();
    let file_id = find_sync_file_id(&client, &access_token).await?;
    let blob = match file_id {
        Some(id) => download_sync_file(&client, &access_token, &id).await?,
        None => SyncBlob::default(),
    };
    Ok(DriveSyncPullResult {
        api_id: blob.api_id,
        api_hash: blob.api_hash,
        has_app_lock: blob.app_lock.is_some(),
        app_lock_email: blob.app_lock.as_ref().map(|lock| lock.email.clone()),
        app_lock_password_hash: blob.app_lock.as_ref().map(|lock| lock.password_hash.clone()),
        app_lock_enabled: blob.app_lock.map(|lock| lock.enabled).unwrap_or(true),
        encrypted_session: blob.encrypted_session,
    })
}

/// Process-local serialization for `drive_sync_push`. Two near-simultaneous
/// pushes (e.g. an app-lock save and a TOTP resync happening close together)
/// would otherwise each do their own download -> merge -> upload with no
/// synchronization, so the second write can silently clobber the first's
/// change (a lost update). This only guards against same-process races —
/// this app has no server component and only one process talks to this
/// Drive appdata file at a time from here, so a real ETag/conditional-write
/// scheme is out of scope, mirroring how narrowly scoped the equivalent fix
/// is on the mobile side (`mobile/src/google/drive.ts`'s `pushQueue`).
static DRIVE_SYNC_PUSH_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();

fn drive_sync_push_lock() -> &'static AsyncMutex<()> {
    DRIVE_SYNC_PUSH_LOCK.get_or_init(|| AsyncMutex::new(()))
}

/// Pushes to the Drive-synced blob, merging onto whatever's already there —
/// pushing `api_id`/`api_hash` from one device must never wipe an `app_lock`
/// block set from another, and vice versa. `None` fields are left untouched.
pub async fn drive_sync_push(
    app: &AppHandle,
    api_id: Option<String>,
    api_hash: Option<String>,
    app_lock: Option<SyncAppLock>,
    encrypted_session: Option<SyncEncryptedSession>,
) -> Result<(), String> {
    // Held for the full download-merge-upload duration below so concurrent
    // calls from this same process serialize instead of racing.
    let _push_guard = drive_sync_push_lock().lock().await;

    let access_token = get_fresh_access_token(app).await?;
    let client = reqwest::Client::new();
    let file_id = find_sync_file_id(&client, &access_token).await?;

    // A found file_id means the sync blob genuinely exists — any failure to
    // download it (network blip, transient Drive error) must be a hard
    // error here, never a silent fallback to an empty blob, or this push
    // would overwrite Drive with only the fields passed in *this* call and
    // wipe out everything else already synced (api_id/api_hash/app_lock/
    // encrypted_session set from other devices or earlier pushes).
    let mut blob = match &file_id {
        Some(id) => download_sync_file(&client, &access_token, id).await?,
        None => SyncBlob::default(),
    };
    blob.version = 1;
    if api_id.is_some() {
        blob.api_id = api_id;
    }
    if api_hash.is_some() {
        blob.api_hash = api_hash;
    }
    if app_lock.is_some() {
        blob.app_lock = app_lock;
    }
    if encrypted_session.is_some() {
        blob.encrypted_session = encrypted_session;
    }

    match file_id {
        Some(id) => update_sync_file(&client, &access_token, &id, &blob).await,
        None => create_sync_file(&client, &access_token, &blob).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_url_safe_has_no_padding_or_reserved_chars() {
        let value = random_url_safe(32);
        assert!(!value.contains('+'));
        assert!(!value.contains('/'));
        assert!(!value.contains('='));
        assert!(!value.is_empty());
    }

    #[test]
    fn random_url_safe_is_not_repeated() {
        assert_ne!(random_url_safe(32), random_url_safe(32));
    }

    #[test]
    fn code_challenge_matches_known_vector() {
        // RFC 7636 Appendix B example.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(code_challenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn parses_code_and_state_from_callback_request() {
        let request = "GET /callback?code=abc123&state=xyz789 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        let (code, state, error) = parse_callback_request(request);
        assert_eq!(code, Some("abc123".to_string()));
        assert_eq!(state, Some("xyz789".to_string()));
        assert_eq!(error, None);
    }

    #[test]
    fn parses_error_from_callback_request() {
        let request = "GET /callback?error=access_denied&state=xyz789 HTTP/1.1\r\n\r\n";
        let (code, state, error) = parse_callback_request(request);
        assert_eq!(code, None);
        assert_eq!(state, Some("xyz789".to_string()));
        assert_eq!(error, Some("access_denied".to_string()));
    }

    #[test]
    fn sync_blob_round_trips_unknown_fields() {
        // Simulates mobile writing a `shares` array that desktop's `SyncBlob`
        // has no field for. Desktop must preserve it through a
        // deserialize -> serialize round trip (i.e. a push), never drop it.
        let remote = serde_json::json!({
            "version": 1,
            "api_id": "12345",
            "shares": [{ "folder_id": "abc", "token": "xyz" }],
        });
        let blob: SyncBlob = serde_json::from_value(remote).expect("should deserialize");
        assert_eq!(blob.api_id, Some("12345".to_string()));

        let round_tripped = serde_json::to_value(&blob).expect("should serialize");
        let shares = round_tripped
            .get("shares")
            .expect("shares key must survive the round trip");
        assert_eq!(
            shares,
            &serde_json::json!([{ "folder_id": "abc", "token": "xyz" }])
        );
    }

    #[test]
    fn decodes_percent_encoded_query_values() {
        let request = "GET /callback?state=a%2Bb%2Fc HTTP/1.1\r\n\r\n";
        let (_, state, _) = parse_callback_request(request);
        assert_eq!(state, Some("a+b/c".to_string()));
    }
}

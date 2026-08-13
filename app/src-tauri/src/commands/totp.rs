//! Authenticator-app (TOTP) support: lets a device that's already completed
//! a full Telegram phone/code login skip redoing that on future logins, and
//! lets a *second* device restore the same Telegram session from Google
//! Drive without a fresh phone/code login either — see `crypto::totp` for
//! the actual RFC 6238 + session-encryption primitives this wraps.
//!
//! Trust model, spelled out because it's easy to get backwards: the raw
//! secret only ever lives on devices that have completed setup or linking.
//! It is NEVER written to the Drive-synced blob — only the *ciphertext* of
//! the session it wraps goes there. So pulling the Drive blob (e.g. via a
//! compromised Google account alone) gets you an opaque, useless blob; you
//! also need the secret (which lives on the user's phone/authenticator app
//! and on already-linked devices) to do anything with it.

use crate::crypto::totp as totp_crypto;
use crate::google_auth::{self, SyncEncryptedSession};
use crate::share_common::VerifyRateLimiter;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------------------
// Local cache (totp.json) — same atomic-write settings-file pattern used
// throughout (google_auth.json, app_lock.json, webdav_settings.json).
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct TotpFile {
    enabled: bool,
    /// Stored as base32 text (not raw bytes) purely so the on-disk file is
    /// human-inspectable/debuggable, same trust tier as `telegram.session`
    /// itself — anyone with local file access already has full account
    /// access via that session file regardless of this one.
    secret_b32: Option<String>,
}

fn totp_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("totp.json"))
}

fn load_totp(app: &AppHandle) -> TotpFile {
    totp_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_totp(app: &AppHandle, file: &TotpFile) -> Result<(), String> {
    let path = totp_path(app)?;
    let temp_path = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(file).map_err(|error| error.to_string())?;
    std::fs::write(&temp_path, contents).map_err(|error| error.to_string())?;
    if std::fs::rename(&temp_path, &path).is_ok() {
        return Ok(());
    }
    std::fs::copy(&temp_path, &path).map_err(|error| error.to_string())?;
    std::fs::remove_file(&temp_path).map_err(|error| error.to_string())
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Session file bytes — checkpoint WAL into the main file first so we read a
// single self-contained snapshot instead of a main file that's missing
// whatever's still sitting in the -wal sidecar.
// ---------------------------------------------------------------------------

fn session_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    Ok(dir.join("telegram.session"))
}

fn read_session_bytes(app: &AppHandle) -> Result<Vec<u8>, String> {
    let path = session_file_path(app)?;
    if !path.exists() {
        return Err("No Telegram session on this device yet.".to_string());
    }
    let path_str = path.to_string_lossy().to_string();
    if let Ok(connection) = sqlite::open(&path_str) {
        // Best-effort — if this fails the file is still readable as-is,
        // just possibly missing very recent writes.
        let _ = connection.execute("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    std::fs::read(&path).map_err(|error| format!("Could not read the session file: {}", error))
}

/// Overwrites (or creates) the session file with restored bytes, clearing
/// any stale -wal/-shm sidecars so the next `SqliteSession::open` sees a
/// clean, consistent file rather than a mismatched leftover WAL.
fn write_session_bytes(app: &AppHandle, bytes: &[u8]) -> Result<(), String> {
    let path = session_file_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let path_str = path.to_string_lossy().to_string();
    let _ = std::fs::remove_file(format!("{}-wal", path_str));
    let _ = std::fs::remove_file(format!("{}-shm", path_str));

    let temp_path = path.with_extension("session.tmp");
    std::fs::write(&temp_path, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temp_path, &path).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Pending setup state — a freshly generated secret isn't persisted until a
// real code from the user's authenticator app confirms it actually works,
// so a setup screen closed halfway never leaves a half-configured secret
// silently enabled.
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct TotpSetupState {
    pending_secret: Mutex<Option<Vec<u8>>>,
    verify_limiter: VerifyRateLimiter,
}

impl TotpSetupState {
    pub fn new() -> Self {
        Self::default()
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct TotpStatusResponse {
    pub enabled: bool,
}

#[tauri::command]
pub async fn cmd_totp_status(app: AppHandle) -> Result<TotpStatusResponse, String> {
    Ok(TotpStatusResponse { enabled: load_totp(&app).enabled })
}

#[derive(Debug, Serialize, Clone)]
pub struct TotpSetupResponse {
    pub base32_secret: String,
    pub otpauth_uri: String,
    pub qr_svg: String,
}

#[tauri::command]
pub async fn cmd_totp_setup_start(
    app: AppHandle,
    setup_state: State<'_, TotpSetupState>,
) -> Result<TotpSetupResponse, String> {
    let account_label = google_auth::load_auth(&app)
        .account_email
        .unwrap_or_else(|| "Telegram Drive".to_string());
    let generated = totp_crypto::generate(&account_label, "Telegram Drive")
        .map_err(|error| error.to_string())?;

    *setup_state.pending_secret.lock().map_err(|_| "Setup state lock was poisoned".to_string())? =
        Some(generated.secret);

    Ok(TotpSetupResponse {
        base32_secret: generated.base32_secret,
        otpauth_uri: generated.otpauth_uri,
        qr_svg: generated.qr_svg,
    })
}

/// Confirms setup with a real code from the authenticator app, persists the
/// secret locally, and pushes the current session (encrypted) to Drive.
#[tauri::command]
pub async fn cmd_totp_setup_confirm(
    code: String,
    app: AppHandle,
    setup_state: State<'_, TotpSetupState>,
) -> Result<(), String> {
    if !setup_state.verify_limiter.check_and_record("__totp_setup__") {
        return Err("Too many attempts. Please wait a few minutes and try again.".to_string());
    }

    let secret = {
        let guard = setup_state
            .pending_secret
            .lock()
            .map_err(|_| "Setup state lock was poisoned".to_string())?;
        guard.clone().ok_or_else(|| "Start setup first.".to_string())?
    };

    if !totp_crypto::verify_code(&secret, &code, now_unix()) {
        return Err("Incorrect code. Check the time on your phone and try again.".to_string());
    }

    save_totp(&app, &TotpFile { enabled: true, secret_b32: Some(totp_crypto::encode_base32(&secret)) })?;
    *setup_state
        .pending_secret
        .lock()
        .map_err(|_| "Setup state lock was poisoned".to_string())? = None;

    push_current_session(&app, &secret).await?;
    Ok(())
}

async fn push_current_session(app: &AppHandle, secret: &[u8]) -> Result<(), String> {
    let session_bytes = read_session_bytes(app)?;
    let (nonce, ciphertext) = totp_crypto::encrypt_session(secret, &session_bytes)
        .map_err(|error| error.to_string())?;
    google_auth::drive_sync_push(
        app,
        None,
        None,
        None,
        Some(SyncEncryptedSession {
            nonce_b64: base64_encode(&nonce),
            ciphertext_b64: base64_encode(&ciphertext),
        }),
    )
    .await
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(bytes)
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(text).map_err(|error| error.to_string())
}

/// Re-syncs the *current* session up to Drive without changing anything
/// about TOTP setup — call this after logout/re-login on an already-set-up
/// device so the Drive copy doesn't go stale.
#[tauri::command]
pub async fn cmd_totp_resync_session(app: AppHandle) -> Result<(), String> {
    let file = load_totp(&app);
    let Some(secret_b32) = file.secret_b32.filter(|_| file.enabled) else {
        return Ok(()); // Not set up on this device — nothing to do.
    };
    let secret = totp_crypto::decode_base32(&secret_b32).map_err(|e| e.to_string())?;
    push_current_session(&app, &secret).await
}

/// Daily-use path for a device that already has the secret cached locally:
/// verify the code, then restore the session Drive already has synced.
#[tauri::command]
pub async fn cmd_totp_verify_and_restore_session(
    code: String,
    app: AppHandle,
    setup_state: State<'_, TotpSetupState>,
) -> Result<(), String> {
    if !setup_state.verify_limiter.check_and_record("__totp_verify__") {
        return Err("Too many attempts. Please wait a few minutes and try again.".to_string());
    }

    let file = load_totp(&app);
    let secret_b32 = file
        .secret_b32
        .filter(|_| file.enabled)
        .ok_or_else(|| "Authenticator isn't set up on this device.".to_string())?;
    let secret = totp_crypto::decode_base32(&secret_b32).map_err(|e| e.to_string())?;

    if !totp_crypto::verify_code(&secret, &code, now_unix()) {
        return Err("Incorrect code.".to_string());
    }

    let pull = google_auth::drive_sync_pull(&app).await?;
    let blob = pull
        .encrypted_session
        .ok_or_else(|| "No synced session found for this account yet.".to_string())?;
    let nonce = base64_decode(&blob.nonce_b64)?;
    let ciphertext = base64_decode(&blob.ciphertext_b64)?;
    let plaintext = totp_crypto::decrypt_session(&secret, &nonce, &ciphertext)
        .map_err(|error| error.to_string())?;
    write_session_bytes(&app, &plaintext)
}

/// New-device path: the user pastes the setup key they saved back when they
/// first set this up (there is no local secret to fall back on yet). A
/// fresh code is still required — proves they actually have the
/// authenticator open right now, not just a copy-pasted string from
/// somewhere — before this device is trusted with the decrypted session.
#[tauri::command]
pub async fn cmd_totp_link_new_device(
    setup_key: String,
    code: String,
    app: AppHandle,
    setup_state: State<'_, TotpSetupState>,
) -> Result<(), String> {
    if !setup_state.verify_limiter.check_and_record("__totp_link__") {
        return Err("Too many attempts. Please wait a few minutes and try again.".to_string());
    }

    let secret = totp_crypto::decode_base32(&setup_key).map_err(|e| e.to_string())?;
    if !totp_crypto::verify_code(&secret, &code, now_unix()) {
        return Err("Incorrect code — double check the setup key and the code on your phone.".to_string());
    }

    let pull = google_auth::drive_sync_pull(&app).await?;
    let blob = pull
        .encrypted_session
        .ok_or_else(|| "No synced session found for this account yet.".to_string())?;
    let nonce = base64_decode(&blob.nonce_b64)?;
    let ciphertext = base64_decode(&blob.ciphertext_b64)?;
    let plaintext = totp_crypto::decrypt_session(&secret, &nonce, &ciphertext)
        .map_err(|error| error.to_string())?;
    write_session_bytes(&app, &plaintext)?;

    // Only persist the secret locally once decryption has actually
    // succeeded — a wrong setup key must never get cached as if it were
    // right.
    save_totp(&app, &TotpFile { enabled: true, secret_b32: Some(totp_crypto::encode_base32(&secret)) })
}

#[tauri::command]
pub async fn cmd_totp_disable(app: AppHandle) -> Result<(), String> {
    save_totp(&app, &TotpFile { enabled: false, secret_b32: None })
}

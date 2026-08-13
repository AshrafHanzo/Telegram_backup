//! "App lock": a secondary local unlock screen (email + password, set via
//! an email-OTP verify-then-set flow) that gates the app *after* Google/
//! Telegram login has already happened on a device. The password hash is
//! cached locally (`app_lock.json`) so unlocking works fully offline; it's
//! refreshed from the Google Drive sync blob on every successful pull (see
//! `commands/google_auth.rs::cmd_google_drive_sync_pull`) so a second
//! device inherits the same lock. This module never touches
//! `grammers_client`/`TelegramState` — the app-lock credential has no
//! relationship to the Telegram account password/2FA.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

use crate::share_common::VerifyRateLimiter;

const OTP_TTL: Duration = Duration::from_secs(10 * 60);

// ---------------------------------------------------------------------------
// Password hashing (Argon2id PHC string) — a different primitive from the
// vault's raw KDF (crypto/kdf.rs): the vault "verifies" by successfully
// AEAD-decrypting ciphertext, and there's no ciphertext here, so a real
// hash-and-compare is the right tool for a plain password check.
// ---------------------------------------------------------------------------

pub fn hash_app_lock_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| error.to_string())
}

pub fn verify_app_lock_password_hash(password: &str, stored_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(stored_hash) else { return false };
    Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()
}

fn hash_otp(code: &str) -> String {
    format!("{:x}", Sha256::digest(code.as_bytes()))
}

fn generate_otp() -> String {
    let value: u32 = rand::Rng::random_range(&mut rand::rng(), 0..1_000_000);
    format!("{:06}", value)
}

// ---------------------------------------------------------------------------
// Local cache (app_lock.json) — same atomic-write settings-file pattern as
// webdav_settings.rs / google_auth.rs.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AppLockFile {
    pub enabled: bool,
    pub email: Option<String>,
    pub password_hash: Option<String>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AppLockStatusResponse {
    pub enabled: bool,
    pub email: Option<String>,
}

fn app_lock_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("app_lock.json"))
}

pub fn load_app_lock(app: &AppHandle) -> AppLockFile {
    app_lock_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_app_lock(app: &AppHandle, file: &AppLockFile) -> Result<(), String> {
    let path = app_lock_path(app)?;
    let temp_path = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(file).map_err(|error| error.to_string())?;
    std::fs::write(&temp_path, contents).map_err(|error| error.to_string())?;
    if std::fs::rename(&temp_path, &path).is_ok() {
        return Ok(());
    }
    std::fs::copy(&temp_path, &path).map_err(|error| error.to_string())?;
    std::fs::remove_file(&temp_path).map_err(|error| error.to_string())
}

pub fn status_response(app: &AppHandle) -> AppLockStatusResponse {
    let file = load_app_lock(app);
    AppLockStatusResponse { enabled: file.enabled, email: file.email }
}

/// Called from `cmd_google_drive_sync_pull` whenever the pulled blob carries
/// an `app_lock` section — refreshes the local cache so a second device
/// inherits the same lock without ever needing the password sent to it in
/// plaintext (only the hash travels, and never to the frontend).
pub fn cache_from_drive(
    app: &AppHandle,
    email: String,
    password_hash: String,
    enabled: bool,
) -> Result<(), String> {
    let file = AppLockFile {
        enabled,
        email: Some(email),
        password_hash: Some(password_hash),
        updated_at: Some(chrono::Utc::now().timestamp()),
    };
    // Pulls only happen right after sign-in/explicit sync, so last-write-wins
    // here is an acceptable, simple default (matches the Drive blob's own
    // merge semantics, which are also last-write-wins per field) — `enabled`
    // now travels with the blob instead of being hardcoded to `true`, so a
    // device that disabled app-lock and pushed that no longer gets silently
    // re-locked by a later pull from a device that hasn't caught up.
    save_app_lock(app, &file)
}

// ---------------------------------------------------------------------------
// OTP store: one pending code per email, single-use, 10-minute TTL, backed
// by the same rate-limiter shape already used for share-link password
// verification (share_common::VerifyRateLimiter) — one instance gates how
// often a code can be *requested* per email, a second gates how often a
// code/password can be *guessed*.
// ---------------------------------------------------------------------------

struct OtpEntry {
    code_hash: String,
    generated_at: Instant,
}

pub struct AppLockOtpState {
    pending: Mutex<HashMap<String, OtpEntry>>,
    send_limiter: VerifyRateLimiter,
    verify_limiter: VerifyRateLimiter,
}

impl AppLockOtpState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            send_limiter: VerifyRateLimiter::new(),
            verify_limiter: VerifyRateLimiter::new(),
        }
    }
}

impl Default for AppLockOtpState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cmd_get_app_lock_status(app: AppHandle) -> Result<AppLockStatusResponse, String> {
    Ok(status_response(&app))
}

#[tauri::command]
pub async fn cmd_set_app_lock_enabled(enabled: bool, app: AppHandle) -> Result<AppLockStatusResponse, String> {
    let mut file = load_app_lock(&app);
    if enabled && file.password_hash.is_none() {
        return Err("Set up a password first.".to_string());
    }
    file.enabled = enabled;
    save_app_lock(&app, &file)?;

    // Best-effort: push the new enabled/disabled state to Drive too, so a
    // second device's next pull sees it instead of resurrecting the old
    // state forever (see `cache_from_drive`'s doc comment). Not fatal if
    // Google isn't connected/reachable — the local toggle still applies.
    if let (Some(email), Some(password_hash)) = (file.email.clone(), file.password_hash.clone()) {
        if let Err(error) = crate::google_auth::drive_sync_push(
            &app,
            None,
            None,
            Some(crate::google_auth::SyncAppLock { email, password_hash, enabled }),
            None,
        )
        .await
        {
            log::warn!("Best-effort push of app-lock enabled={} to Drive failed (local toggle still applies): {}", enabled, error);
        }
    }

    Ok(status_response(&app))
}

/// Rate-limited on its own key so repeated wrong guesses against the
/// already-cached hash are throttled even though calling it already implies
/// IPC access (i.e. running as the local OS user) — defense in depth.
#[tauri::command]
pub async fn cmd_verify_app_lock_password(
    password: String,
    app: AppHandle,
    otp_state: State<'_, AppLockOtpState>,
) -> Result<bool, String> {
    if !otp_state.verify_limiter.check_and_record("__app_lock_password__") {
        return Err("Too many attempts. Please wait a few minutes and try again.".to_string());
    }
    let file = load_app_lock(&app);
    let Some(hash) = file.password_hash else { return Ok(false) };
    Ok(verify_app_lock_password_hash(&password, &hash))
}

#[tauri::command]
pub async fn cmd_send_app_lock_otp(
    email: String,
    app: AppHandle,
    otp_state: State<'_, AppLockOtpState>,
) -> Result<(), String> {
    let email = email.trim().to_string();
    if email.is_empty() || !email.contains('@') {
        return Err("Enter a valid email address.".to_string());
    }
    if !otp_state.send_limiter.check_and_record(&email) {
        return Err("Too many codes requested for this address. Please wait a few minutes and try again.".to_string());
    }

    let code = generate_otp();
    {
        let mut pending = otp_state
            .pending
            .lock()
            .map_err(|_| "OTP store lock was poisoned".to_string())?;
        pending.insert(email.clone(), OtpEntry { code_hash: hash_otp(&code), generated_at: Instant::now() });
    }

    crate::commands::smtp_settings::send_otp_email(&app, &email, &code).await
}

#[tauri::command]
pub async fn cmd_verify_otp_and_set_app_lock(
    email: String,
    otp: String,
    new_password: String,
    app: AppHandle,
    otp_state: State<'_, AppLockOtpState>,
) -> Result<AppLockStatusResponse, String> {
    let email = email.trim().to_string();
    if new_password.len() < 6 {
        return Err("Choose a password with at least 6 characters.".to_string());
    }

    // If an app lock is already configured, this call is a reset — the
    // caller must prove they know the email it's already set to, not just
    // any inbox they control. Without this check, anyone sitting at the
    // locked screen could type in their own address, verify the OTP sent to
    // themselves, and set a brand-new password with zero knowledge of the
    // original — a full bypass. First-time setup (no existing lock) has
    // nothing to protect yet, so any verified email is fine there.
    let existing = load_app_lock(&app);
    if existing.enabled {
        if let Some(existing_email) = existing.email.as_deref() {
            if !existing_email.eq_ignore_ascii_case(&email) {
                return Err(
                    "This isn't the email your app lock is set to. Enter that email to reset it."
                        .to_string(),
                );
            }
        }
    }

    if !otp_state.verify_limiter.check_and_record(&email) {
        return Err("Too many attempts. Please request a new code.".to_string());
    }

    {
        let mut pending = otp_state
            .pending
            .lock()
            .map_err(|_| "OTP store lock was poisoned".to_string())?;
        let entry = pending
            .get(&email)
            .ok_or_else(|| "Request a new code first.".to_string())?;
        if entry.generated_at.elapsed() > OTP_TTL {
            pending.remove(&email);
            return Err("This code has expired. Request a new one.".to_string());
        }
        if !constant_time_eq::constant_time_eq(entry.code_hash.as_bytes(), hash_otp(otp.trim()).as_bytes()) {
            return Err("Incorrect code.".to_string());
        }
        pending.remove(&email);
    }

    let password_hash = hash_app_lock_password(&new_password)?;
    let file = AppLockFile {
        enabled: true,
        email: Some(email.clone()),
        password_hash: Some(password_hash.clone()),
        updated_at: Some(chrono::Utc::now().timestamp()),
    };
    save_app_lock(&app, &file)?;

    // Best-effort: also push to the Drive-synced blob so other devices
    // inherit the same lock. Not fatal if Google isn't connected/reachable
    // — app-lock still gets enabled locally either way.
    if let Err(error) = crate::google_auth::drive_sync_push(
        &app,
        None,
        None,
        Some(crate::google_auth::SyncAppLock { email, password_hash, enabled: true }),
        None,
    )
    .await
    {
        log::warn!("Best-effort push of newly-set app-lock to Drive failed (local app-lock still enabled): {}", error);
    }

    Ok(status_response(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_and_verifies_a_password() {
        let hash = hash_app_lock_password("correct-password").unwrap();
        assert!(verify_app_lock_password_hash("correct-password", &hash));
        assert!(!verify_app_lock_password_hash("wrong-password", &hash));
    }

    #[test]
    fn each_hash_uses_a_fresh_salt() {
        let a = hash_app_lock_password("same-password").unwrap();
        let b = hash_app_lock_password("same-password").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn rejects_garbage_stored_hash_instead_of_panicking() {
        assert!(!verify_app_lock_password_hash("anything", "not-a-real-hash"));
    }

    #[test]
    fn otp_is_six_digits() {
        for _ in 0..20 {
            let otp = generate_otp();
            assert_eq!(otp.len(), 6);
            assert!(otp.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn otp_hash_is_deterministic_for_verification() {
        assert_eq!(hash_otp("123456"), hash_otp("123456"));
        assert_ne!(hash_otp("123456"), hash_otp("654321"));
    }
}

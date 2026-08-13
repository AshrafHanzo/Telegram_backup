//! Thin `#[tauri::command]` wrappers around `crate::google_auth`'s core
//! OAuth/Drive-sync logic — kept separate from that module the same way
//! `commands/sharing.rs` is a thin command layer over `crate::share_common`.

use tauri::AppHandle;

use crate::google_auth::{self, GoogleAccountResponse, GoogleOAuthPollResult, SyncAppLock};

#[tauri::command]
pub async fn cmd_set_google_oauth_client(
    client_id: String,
    client_secret: String,
    app: AppHandle,
) -> Result<GoogleAccountResponse, String> {
    let trimmed_id = client_id.trim().to_string();
    let trimmed_secret = client_secret.trim().to_string();
    if trimmed_id.is_empty() || trimmed_secret.is_empty() {
        return Err("Both the Client ID and Client Secret are required.".to_string());
    }
    let mut auth = google_auth::load_auth(&app);
    auth.client_id = Some(trimmed_id);
    auth.client_secret = Some(trimmed_secret);
    google_auth::save_auth(&app, &auth)?;
    Ok(google_auth::account_response(&app))
}

#[tauri::command]
pub async fn cmd_google_oauth_start(app: AppHandle) -> Result<String, String> {
    google_auth::start_oauth_flow(app).await
}

#[tauri::command]
pub async fn cmd_google_oauth_poll(app: AppHandle) -> Result<GoogleOAuthPollResult, String> {
    google_auth::poll_oauth_flow(&app)
}

#[tauri::command]
pub async fn cmd_google_oauth_cancel(app: AppHandle) -> Result<(), String> {
    google_auth::cancel_oauth_flow(&app)
}

#[tauri::command]
pub async fn cmd_get_google_account(app: AppHandle) -> Result<GoogleAccountResponse, String> {
    Ok(google_auth::account_response(&app))
}

#[tauri::command]
pub async fn cmd_google_sign_out(app: AppHandle) -> Result<GoogleAccountResponse, String> {
    google_auth::sign_out(&app)?;
    Ok(google_auth::account_response(&app))
}

#[derive(serde::Serialize)]
pub struct DriveSyncPullResponse {
    pub api_id: Option<String>,
    pub api_hash: Option<String>,
    pub has_app_lock: bool,
    pub app_lock_email: Option<String>,
}

#[tauri::command]
pub async fn cmd_google_drive_sync_pull(app: AppHandle) -> Result<DriveSyncPullResponse, String> {
    let result = google_auth::drive_sync_pull(&app).await?;

    // If the synced blob carries an app-lock section, refresh the local
    // cache so this device's offline unlock screen matches — the hash is
    // consumed here, server-side, and never included in the response below.
    if let (Some(email), Some(hash)) = (result.app_lock_email.clone(), result.app_lock_password_hash.clone()) {
        if let Err(error) = crate::commands::app_lock::cache_from_drive(&app, email, hash, result.app_lock_enabled) {
            // Best-effort local cache write — the pull itself still succeeded
            // (see below), so this is deliberately just a diagnostic trail,
            // not a reason to fail the whole pull.
            log::warn!("Failed to cache app-lock from Drive pull locally: {}", error);
        }
    }

    Ok(DriveSyncPullResponse {
        api_id: result.api_id,
        api_hash: result.api_hash,
        has_app_lock: result.has_app_lock,
        app_lock_email: result.app_lock_email,
    })
}

#[tauri::command]
pub async fn cmd_google_drive_sync_push(
    api_id: Option<String>,
    api_hash: Option<String>,
    app_lock_email: Option<String>,
    app_lock_password_hash: Option<String>,
    app_lock_enabled: Option<bool>,
    app: AppHandle,
) -> Result<(), String> {
    let app_lock = match (app_lock_email, app_lock_password_hash) {
        (Some(email), Some(hash))
            if !email.trim().is_empty() && !hash.trim().is_empty() =>
        {
            Some(SyncAppLock {
                email: email.trim().to_string(),
                password_hash: hash,
                enabled: app_lock_enabled.unwrap_or(true),
            })
        }
        _ => None,
    };
    google_auth::drive_sync_push(&app, api_id, api_hash, app_lock, None).await
}

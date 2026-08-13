//! SMTP sender configuration for the app-lock OTP email — the user's own
//! Gmail address + an "App Password" (myaccount.google.com/apppasswords),
//! used only to deliver the one-time codes in `commands/app_lock.rs`. This
//! is intentionally separate from the Google OAuth Client ID/Secret in
//! `google_auth.rs`: OAuth grants Drive access, this is a plain SMTP login.

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SmtpSettingsFile {
    pub gmail_address: Option<String>,
    /// Plaintext at rest — an accepted, pre-existing class of gap in this
    /// codebase (the SOCKS5/HTTP proxy password has the same limitation in
    /// `vpn_optimizer.rs`); no new at-rest encryption scheme is introduced
    /// here.
    pub app_password: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SmtpSettingsResponse {
    pub gmail_address: Option<String>,
    pub configured: bool,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("smtp_settings.json"))
}

pub fn load_settings(app: &AppHandle) -> SmtpSettingsFile {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &SmtpSettingsFile) -> Result<(), String> {
    let path = settings_path(app)?;
    let temp_path = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    std::fs::write(&temp_path, contents).map_err(|error| error.to_string())?;
    if std::fs::rename(&temp_path, &path).is_ok() {
        return Ok(());
    }
    std::fs::copy(&temp_path, &path).map_err(|error| error.to_string())?;
    std::fs::remove_file(&temp_path).map_err(|error| error.to_string())
}

fn response(settings: &SmtpSettingsFile) -> SmtpSettingsResponse {
    SmtpSettingsResponse {
        gmail_address: settings.gmail_address.clone(),
        configured: settings.gmail_address.is_some() && settings.app_password.is_some(),
    }
}

#[tauri::command]
pub async fn cmd_get_smtp_settings(app: AppHandle) -> Result<SmtpSettingsResponse, String> {
    Ok(response(&load_settings(&app)))
}

#[tauri::command]
pub async fn cmd_update_smtp_settings(
    gmail_address: String,
    app_password: String,
    app: AppHandle,
) -> Result<SmtpSettingsResponse, String> {
    let gmail_address = gmail_address.trim().to_string();
    let app_password = app_password.trim().replace(' ', ""); // Google shows it with spaces; SMTP wants it without.
    if gmail_address.is_empty() || app_password.is_empty() {
        return Err("Both the Gmail address and App Password are required.".to_string());
    }
    let settings = SmtpSettingsFile { gmail_address: Some(gmail_address), app_password: Some(app_password) };
    save_settings(&app, &settings)?;
    Ok(response(&settings))
}

/// Sends a plain-text OTP email via Gmail SMTP/STARTTLS on port 587. Not a
/// Tauri command — called from `commands/app_lock.rs::cmd_send_app_lock_otp`.
pub async fn send_otp_email(app: &AppHandle, to_email: &str, otp: &str) -> Result<(), String> {
    let settings = load_settings(app);
    let gmail_address = settings
        .gmail_address
        .ok_or_else(|| "Set up an email sender in Settings \u{2192} App Lock before sending a code.".to_string())?;
    let app_password = settings
        .app_password
        .ok_or_else(|| "Set up an email sender in Settings \u{2192} App Lock before sending a code.".to_string())?;

    let from: Mailbox = gmail_address
        .parse()
        .map_err(|error| format!("Invalid sender address: {}", error))?;
    let to: Mailbox = to_email
        .parse()
        .map_err(|error| format!("Invalid recipient address: {}", error))?;

    let email = Message::builder()
        .from(from)
        .to(to)
        .subject("Your Telegram Drive verification code")
        .body(format!(
            "Your one-time code is: {}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.",
            otp
        ))
        .map_err(|error| format!("Failed to build email: {}", error))?;

    let creds = Credentials::new(gmail_address, app_password);
    let mailer: AsyncSmtpTransport<Tokio1Executor> = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay("smtp.gmail.com")
        .map_err(|error| format!("Failed to configure SMTP: {}", error))?
        .port(587)
        .credentials(creds)
        .build();

    mailer
        .send(email)
        .await
        .map_err(|error| format!("Failed to send email: {}", error))?;
    Ok(())
}

use tauri::{AppHandle, State};

use crate::relay::{self, RelayStatusResponse};
use crate::TelegramState;

#[tauri::command]
pub async fn cmd_get_relay_status(app: AppHandle) -> Result<RelayStatusResponse, String> {
    Ok(relay::status(&app))
}

#[tauri::command]
pub async fn cmd_set_relay_bot_token(bot_token: String, app: AppHandle) -> Result<RelayStatusResponse, String> {
    let (bot_user_id, bot_username) = relay::resolve_bot_identity(&bot_token).await?;
    let mut settings = relay::load_settings(&app);
    settings.bot_token = Some(bot_token);
    settings.bot_user_id = Some(bot_user_id);
    settings.bot_username = Some(bot_username);
    relay::save_settings(&app, &settings)?;
    Ok(relay::status(&app))
}

#[tauri::command]
pub async fn cmd_set_relay_worker_config(
    worker_url: String,
    admin_secret: String,
    app: AppHandle,
) -> Result<RelayStatusResponse, String> {
    let mut settings = relay::load_settings(&app);
    settings.worker_url = Some(worker_url.trim_end_matches('/').to_string());
    settings.admin_secret = Some(admin_secret);
    relay::save_settings(&app, &settings)?;
    Ok(relay::status(&app))
}

/// Ensures the hidden relay channel exists and the bot is an admin of both
/// it and the target folder — called before creating an always-on share.
/// Kept separate from cmd_create_folder_share so the frontend can surface
/// this (slower, one-time-per-folder) step distinctly from the fast path of
/// creating additional links for a folder that's already set up.
#[tauri::command]
pub async fn cmd_prepare_folder_for_relay(
    folder_id: i64,
    tg_state: State<'_, TelegramState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings = relay::load_settings(&app);
    let bot_username = settings
        .bot_username
        .ok_or_else(|| "Set a bot token in Settings first".to_string())?;

    let client = {
        tg_state
            .client
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Telegram is not connected".to_string())?
    };

    let relay_channel_id = relay::ensure_relay_channel(&app, &client, &tg_state.peer_cache).await?;
    relay::ensure_bot_is_admin(&client, relay_channel_id, &bot_username, &tg_state.peer_cache).await?;
    relay::ensure_bot_is_admin(&client, folder_id, &bot_username, &tg_state.peer_cache).await?;
    Ok(())
}

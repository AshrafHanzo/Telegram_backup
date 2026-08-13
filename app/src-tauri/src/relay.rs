//! Desktop-side half of the always-on Temp Link relay (see
//! `app/cloudflare-worker/src/worker.js` for the serverless half). Handles:
//! - Persisting the bot token / Worker URL / admin secret the user sets up
//!   once by hand (BotFather + `wrangler deploy` — see the Worker's README).
//! - Adding the bot as an admin of a folder's channel (and a hidden "relay"
//!   channel used as scratch space for the Worker's forward-then-getFile
//!   trick) via raw MTProto calls, since grammers has no high-level wrapper
//!   for inviting/promoting another user.
//! - Pushing/revoking share records in the Worker's KV store over HTTPS.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct RelaySettingsFile {
    pub bot_token: Option<String>,
    pub bot_user_id: Option<i64>,
    pub bot_username: Option<String>,
    pub relay_channel_id: Option<i64>,
    pub worker_url: Option<String>,
    pub admin_secret: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct RelayStatusResponse {
    pub bot_configured: bool,
    pub bot_username: Option<String>,
    pub worker_configured: bool,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("relay_settings.json"))
}

pub fn load_settings(app: &AppHandle) -> RelaySettingsFile {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

pub fn save_settings(app: &AppHandle, settings: &RelaySettingsFile) -> Result<(), String> {
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

pub fn status(app: &AppHandle) -> RelayStatusResponse {
    let settings = load_settings(app);
    RelayStatusResponse {
        bot_configured: settings.bot_token.is_some() && settings.bot_username.is_some(),
        bot_username: settings.bot_username,
        worker_configured: settings.worker_url.is_some() && settings.admin_secret.is_some(),
    }
}

/// Calls the Bot API's `getMe` to resolve the bot's id/username, so we don't
/// have to ask the user to type those in separately from the token.
pub async fn resolve_bot_identity(bot_token: &str) -> Result<(i64, String), String> {
    let url = format!("https://api.telegram.org/bot{}/getMe", bot_token);
    let response = reqwest::get(&url)
        .await
        .map_err(|error| format!("Could not reach Telegram: {}", error))?;
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("Unexpected response from Telegram: {}", error))?;
    if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let description = body
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("invalid bot token");
        return Err(format!("Telegram rejected this bot token: {}", description));
    }
    let result = body.get("result").ok_or("Malformed getMe response")?;
    let user_id = result
        .get("id")
        .and_then(|v| v.as_i64())
        .ok_or("Bot has no id")?;
    let username = result
        .get("username")
        .and_then(|v| v.as_str())
        .ok_or("Bot has no username")?
        .to_string();
    Ok((user_id, username))
}

/// Invites (if needed) and promotes the bot to admin in `channel_id`, using
/// raw MTProto calls since grammers has no high-level wrapper for either
/// step. Already-a-participant/already-admin responses are treated as
/// success, not errors — this is meant to be safely callable repeatedly.
pub async fn ensure_bot_is_admin(
    client: &grammers_client::Client,
    channel_id: i64,
    bot_username: &str,
    peer_cache: &std::sync::Arc<tokio::sync::RwLock<std::collections::HashMap<i64, grammers_client::types::Peer>>>,
) -> Result<(), String> {
    use grammers_tl_types as tl;

    let channel_peer =
        crate::commands::utils::resolve_peer(client, Some(channel_id), peer_cache).await?;
    let (raw_channel_id, channel_access_hash) = match &channel_peer {
        grammers_client::types::Peer::Channel(c) => (
            c.raw.id,
            c.raw
                .access_hash
                .ok_or_else(|| "No access hash for this folder's channel".to_string())?,
        ),
        _ => return Err("Always-on links are only supported for folders (channels)".to_string()),
    };
    let input_channel = tl::enums::InputChannel::Channel(tl::types::InputChannel {
        channel_id: raw_channel_id,
        access_hash: channel_access_hash,
    });

    let bot_peer = client
        .resolve_username(bot_username)
        .await
        .map_err(|error| format!("Could not look up the bot: {}", error))?
        .ok_or_else(|| {
            "Could not find this bot on Telegram — message it once with /start first".to_string()
        })?;
    let (bot_user_id, bot_access_hash) = match &bot_peer {
        grammers_client::types::Peer::User(u) => match &u.raw {
            tl::enums::User::User(raw) => (
                raw.id,
                raw.access_hash
                    .ok_or_else(|| "No access hash for the bot".to_string())?,
            ),
            tl::enums::User::Empty(_) => return Err("Bot account is not accessible".to_string()),
        },
        _ => return Err("Resolved bot username is not a user".to_string()),
    };
    let input_user = tl::enums::InputUser::User(tl::types::InputUser {
        user_id: bot_user_id,
        access_hash: bot_access_hash,
    });

    // Invite first — ignore "already there" style failures; anything else
    // (e.g. the bot doesn't exist, or we lack invite rights) is real.
    let invite_result = client
        .invoke(&tl::functions::channels::InviteToChannel {
            channel: input_channel.clone(),
            users: vec![input_user.clone()],
        })
        .await;
    if let Err(error) = invite_result {
        let message = error.to_string();
        if !message.contains("USER_ALREADY_PARTICIPANT") {
            return Err(format!("Could not add the bot to this folder: {}", message));
        }
    }

    client
        .invoke(&tl::functions::channels::EditAdmin {
            channel: input_channel,
            user_id: input_user,
            admin_rights: tl::enums::ChatAdminRights::Rights(tl::types::ChatAdminRights {
                change_info: false,
                post_messages: true,
                edit_messages: false,
                delete_messages: true,
                ban_users: false,
                invite_users: false,
                pin_messages: false,
                add_admins: false,
                anonymous: false,
                manage_call: false,
                other: false,
                manage_topics: false,
                post_stories: false,
                edit_stories: false,
                delete_stories: false,
                manage_direct_messages: false,
            }),
            rank: "Relay".to_string(),
        })
        .await
        .map_err(|error| format!("Could not grant the bot admin rights: {}", error))?;

    Ok(())
}

/// Creates the hidden relay channel on first use and remembers its id;
/// reuses the same one afterward. This channel is never shown in the
/// folder list — it exists purely as scratch space the Worker forwards
/// messages into to read their file_id, then deletes them again.
pub async fn ensure_relay_channel(
    app: &AppHandle,
    client: &grammers_client::Client,
    peer_cache: &std::sync::Arc<tokio::sync::RwLock<std::collections::HashMap<i64, grammers_client::types::Peer>>>,
) -> Result<i64, String> {
    let mut settings = load_settings(app);
    if let Some(existing) = settings.relay_channel_id {
        return Ok(existing);
    }

    let channel_id = crate::commands::fs::create_channel_raw(
        "Telegram Drive Relay (do not delete)".to_string(),
        "Internal scratch channel for always-on Temp Links. Safe to ignore — do not delete or rename.\n[telegram-drive-relay-channel]".to_string(),
        client,
        peer_cache,
    )
    .await?;

    settings.relay_channel_id = Some(channel_id);
    save_settings(app, &settings)?;
    Ok(channel_id)
}

/// Registers/updates a share record in the Worker's KV store so it starts
/// (or keeps) working from the Worker independent of this app running.
pub async fn push_share(
    settings: &RelaySettingsFile,
    token: &str,
    record: &serde_json::Value,
) -> Result<(), String> {
    let worker_url = settings
        .worker_url
        .as_ref()
        .ok_or_else(|| "Always-on relay is not configured yet".to_string())?;
    let admin_secret = settings
        .admin_secret
        .as_ref()
        .ok_or_else(|| "Always-on relay is not configured yet".to_string())?;

    let client = reqwest::Client::new();
    let response = client
        .put(format!(
            "{}/admin/shares/{}",
            worker_url.trim_end_matches('/'),
            token
        ))
        .bearer_auth(admin_secret)
        .json(record)
        .send()
        .await
        .map_err(|error| format!("Could not reach the relay Worker: {}", error))?;
    if !response.status().is_success() {
        return Err(format!(
            "Relay Worker rejected the share ({})",
            response.status()
        ));
    }
    Ok(())
}

pub async fn revoke_share(settings: &RelaySettingsFile, token: &str) -> Result<(), String> {
    let (Some(worker_url), Some(admin_secret)) = (&settings.worker_url, &settings.admin_secret)
    else {
        // Relay was never configured, so there's nothing to revoke there.
        return Ok(());
    };
    let client = reqwest::Client::new();
    let _ = client
        .delete(format!(
            "{}/admin/shares/{}",
            worker_url.trim_end_matches('/'),
            token
        ))
        .bearer_auth(admin_secret)
        .send()
        .await;
    Ok(())
}

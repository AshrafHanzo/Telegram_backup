use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use rand::Rng;
use crate::db::DbConnection;
use crate::share_permissions::SharePermissions;
use crate::tunnel::TunnelState;

/// The public tunnel URL if one is currently up (see tunnel.rs), otherwise
/// the local-only loopback address as before — links still work on this
/// machine even when the tunnel hasn't started yet or couldn't be reached.
fn share_base_url(app: &AppHandle) -> String {
    app.try_state::<std::sync::Arc<TunnelState>>()
        .and_then(|state| state.base_url())
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::STREAM_PORT))
}

#[derive(Debug, Serialize)]
pub struct TunnelStatusResponse {
    /// True once cloudflared has reported a live public URL. While false,
    /// links still get created — they just resolve to the loopback address,
    /// so only work on this machine until the tunnel comes up (it can take
    /// a few seconds after app launch) or if it never started at all.
    pub public: bool,
    pub base_url: String,
}

#[tauri::command]
pub async fn cmd_get_share_tunnel_status(app: AppHandle) -> Result<TunnelStatusResponse, String> {
    let tunnel_url = app
        .try_state::<std::sync::Arc<TunnelState>>()
        .and_then(|state| state.base_url());
    Ok(TunnelStatusResponse {
        public: tunnel_url.is_some(),
        base_url: tunnel_url.unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::STREAM_PORT)),
    })
}

#[derive(Debug, Serialize)]
pub struct ShareInfo {
    pub id: String,
    pub folder_id: Option<i64>,
    pub message_id: i32,
    pub file_name: String,
    pub file_size: i64,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub revoked: bool,
    pub has_password: bool,
    pub link: String,
    pub always_on: bool,
    pub usage_limit: Option<i64>,
    pub usage_count: i64,
}

#[derive(Debug, Serialize)]
pub struct FolderShareInfo {
    pub id: String,
    pub folder_id: Option<i64>,
    pub folder_name: String,
    pub can_upload: bool,
    pub can_download: bool,
    pub can_update: bool,
    pub can_delete: bool,
    pub has_password: bool,
    /// The login username, if this link requires one alongside its
    /// password. Not a secret (like a password would be) — it's an
    /// identifier the creator needs to be able to hand to whoever they
    /// share the link with, so unlike `password_hash` it's returned as-is
    /// rather than reduced to a boolean.
    pub username: Option<String>,
    pub expires_at: Option<i64>,
    pub revoked: bool,
    pub created_at: i64,
    pub link: String,
}

fn generate_share_token() -> String {
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..16).map(|_| rng.random()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Hash a password using bcrypt (cost factor 12).
/// bcrypt embeds the salt in the output hash string, so no separate salt storage is needed.
fn hash_password(password: &str) -> Result<String, String> {
    bcrypt::hash(password, 12).map_err(|e| format!("Password hashing failed: {}", e))
}

#[tauri::command]
pub async fn cmd_create_share(
    folder_id: Option<i64>,
    message_id: i32,
    file_name: String,
    file_size: i64,
    password: Option<String>,
    expiry_hours: Option<i64>,
    always_on: Option<bool>,
    usage_limit: Option<i64>,
    db_pool: State<'_, DbConnection>,
    tg_state: State<'_, crate::TelegramState>,
    app: AppHandle,
) -> Result<ShareInfo, String> {
    {
        let conn = db_pool.lock().map_err(|e| e.to_string())?;
        let folder_key = folder_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "home".to_string());
        let mut encrypted = conn
            .prepare("SELECT 1 FROM encrypted_files WHERE folder_key = ? AND message_id = ? AND record_state = 'active'")
            .map_err(|e| e.to_string())?;
        encrypted.bind((1, folder_key.as_str())).map_err(|e| e.to_string())?;
        encrypted.bind((2, i64::from(message_id))).map_err(|e| e.to_string())?;
        if matches!(encrypted.next(), Ok(sqlite::State::Row)) {
            return Err("[ENCRYPTED_SHARE_UNAVAILABLE] Encrypted sharing is disabled until a credential-safe sharing flow is available".to_string());
        }
    }

    let always_on = always_on.unwrap_or(false);
    if always_on && folder_id.is_none() {
        return Err("Always-on links need a real folder — Saved Messages can't have a bot added to it".to_string());
    }

    let token = generate_share_token();
    let created_at = chrono::Utc::now().timestamp();
    let expires_at = expiry_hours.map(|hours| created_at + hours * 3600);

    let password_hash = if let Some(ref pwd) = password {
        if pwd.is_empty() {
            None
        } else {
            // bcrypt embeds the salt in the hash; password_salt column set to NULL.
            let hash = hash_password(pwd)?;
            Some(hash)
        }
    } else {
        None
    };

    // Set up the bot relay before writing the row, so a failure here doesn't
    // leave a half-configured "always-on" share sitting in the database.
    let relay_settings = crate::relay::load_settings(&app);
    if always_on {
        let bot_username = relay_settings
            .bot_username
            .clone()
            .ok_or_else(|| "Set up a bot in Settings → Sharing → Always-on links first".to_string())?;
        if relay_settings.worker_url.is_none() || relay_settings.admin_secret.is_none() {
            return Err("Deploy and configure the relay Worker in Settings → Sharing → Always-on links first".to_string());
        }
        let client = {
            tg_state
                .client
                .lock()
                .await
                .clone()
                .ok_or_else(|| "Telegram is not connected".to_string())?
        };
        let relay_channel_id =
            crate::relay::ensure_relay_channel(&app, &client, &tg_state.peer_cache).await?;
        crate::relay::ensure_bot_is_admin(&client, relay_channel_id, &bot_username, &tg_state.peer_cache).await?;
        crate::relay::ensure_bot_is_admin(&client, folder_id.unwrap(), &bot_username, &tg_state.peer_cache).await?;
    }

    {
        let conn = db_pool.lock().map_err(|e| e.to_string())?;

        let mut stmt = conn.prepare(
            "INSERT INTO shared_links (id, folder_id, message_id, file_name, file_size, password_hash, password_salt, expires_at, revoked, created_at, always_on, usage_limit, usage_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)"
        ).map_err(|e| e.to_string())?;

        stmt.bind((1, token.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((2, folder_id)).map_err(|e| e.to_string())?;
        stmt.bind((3, message_id as i64)).map_err(|e| e.to_string())?;
        stmt.bind((4, file_name.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((5, file_size)).map_err(|e| e.to_string())?;
        stmt.bind((6, password_hash.as_deref())).map_err(|e| e.to_string())?;
        stmt.bind::<(usize, Option<&str>)>((7, None)).map_err(|e| e.to_string())?;
        stmt.bind((8, expires_at)).map_err(|e| e.to_string())?;
        stmt.bind((9, created_at)).map_err(|e| e.to_string())?;
        stmt.bind((10, always_on as i64)).map_err(|e| e.to_string())?;
        stmt.bind((11, usage_limit)).map_err(|e| e.to_string())?;

        stmt.next().map_err(|e| e.to_string())?;
    }

    let link = if always_on {
        let record = serde_json::json!({
            "sourceChatId": folder_id,
            "messageId": message_id,
            "relayChatId": relay_settings.relay_channel_id,
            "botToken": relay_settings.bot_token,
            "permissions": crate::share_permissions::SharePermissions::DOWNLOAD.bits(),
            "passwordHash": password_hash,
            "expiresAt": expires_at,
            "usageLimit": usage_limit,
            "usageCount": 0,
            "revoked": false,
        });
        crate::relay::push_share(&relay_settings, &token, &record).await?;
        format!("{}/s/{}", relay_settings.worker_url.unwrap(), token)
    } else {
        format!("{}/d/{}", share_base_url(&app), token)
    };

    Ok(ShareInfo {
        id: token,
        folder_id,
        message_id,
        file_name,
        file_size,
        created_at,
        expires_at,
        revoked: false,
        has_password: password_hash.is_some(),
        link,
        always_on,
        usage_limit,
        usage_count: 0,
    })
}

#[tauri::command]
pub async fn cmd_list_shares(
    db_pool: State<'_, DbConnection>,
    app: AppHandle,
) -> Result<Vec<ShareInfo>, String> {
    let base_url = share_base_url(&app);
    let relay_settings = crate::relay::load_settings(&app);
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, folder_id, message_id, file_name, file_size, password_hash, expires_at, created_at, revoked, always_on, usage_limit, usage_count
             FROM shared_links WHERE revoked = 0 ORDER BY created_at DESC"
        )
        .map_err(|e| e.to_string())?;

    let mut shares = Vec::new();
    while let sqlite::State::Row = stmt.next().map_err(|e| e.to_string())? {
        let id = stmt.read::<String, _>("id").map_err(|e| e.to_string())?;
        let folder_id = stmt.read::<Option<i64>, _>("folder_id").ok().flatten();
        let message_id = stmt.read::<i64, _>("message_id").map_err(|e| e.to_string())? as i32;
        let has_password = stmt.read::<Option<String>, _>("password_hash").ok().flatten().is_some();
        let expires_at = stmt.read::<Option<i64>, _>("expires_at").ok().flatten();
        let file_name = stmt.read::<String, _>("file_name").map_err(|e| e.to_string())?;
        let file_size = stmt.read::<i64, _>("file_size").map_err(|e| e.to_string())?;
        let created_at = stmt.read::<i64, _>("created_at").map_err(|e| e.to_string())?;
        let revoked = stmt.read::<i64, _>("revoked").map_err(|e| e.to_string())? != 0;
        let always_on = stmt.read::<i64, _>("always_on").unwrap_or(0) != 0;
        let usage_limit = stmt.read::<Option<i64>, _>("usage_limit").ok().flatten();
        let usage_count = stmt.read::<i64, _>("usage_count").unwrap_or(0);
        let link = if always_on {
            match &relay_settings.worker_url {
                Some(worker_url) => format!("{}/s/{}", worker_url, id),
                None => format!("{}/d/{}", base_url, id),
            }
        } else {
            format!("{}/d/{}", base_url, id)
        };

        shares.push(ShareInfo {
            id,
            folder_id,
            message_id,
            file_name,
            file_size,
            created_at,
            expires_at,
            revoked,
            has_password,
            link,
            always_on,
            usage_limit,
            usage_count,
        });
    }

    Ok(shares)
}

#[tauri::command]
pub async fn cmd_revoke_share(
    id: String,
    db_pool: State<'_, DbConnection>,
    app: AppHandle,
) -> Result<(), String> {
    {
        let conn = db_pool.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("UPDATE shared_links SET revoked = 1 WHERE id = ?").map_err(|e| e.to_string())?;
        stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
        stmt.next().map_err(|e| e.to_string())?;
    }

    // Best-effort: harmless no-op if this share was never always-on, or the
    // relay was never configured at all.
    let relay_settings = crate::relay::load_settings(&app);
    let _ = crate::relay::revoke_share(&relay_settings, &id).await;

    Ok(())
}

// --- Temp Link Generator: permissioned, folder-scoped shares ---

#[tauri::command]
pub async fn cmd_create_folder_share(
    folder_id: Option<i64>,
    folder_name: String,
    can_upload: bool,
    can_download: bool,
    can_update: bool,
    can_delete: bool,
    username: Option<String>,
    password: Option<String>,
    expiry_hours: Option<i64>,
    db_pool: State<'_, DbConnection>,
    app: AppHandle,
) -> Result<FolderShareInfo, String> {
    let mut permissions = SharePermissions::empty();
    if can_upload { permissions |= SharePermissions::UPLOAD; }
    if can_download { permissions |= SharePermissions::DOWNLOAD; }
    if can_update { permissions |= SharePermissions::UPDATE; }
    if can_delete { permissions |= SharePermissions::DELETE; }
    if permissions.is_empty() {
        return Err("Choose at least one permission for this link".to_string());
    }

    let token = generate_share_token();
    let created_at = chrono::Utc::now().timestamp();
    let expires_at = expiry_hours.map(|hours| created_at + hours * 3600);

    let password_hash = match password {
        Some(ref pwd) if !pwd.is_empty() => Some(hash_password(pwd)?),
        _ => None,
    };
    let username = username.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    if username.is_some() && password_hash.is_none() {
        return Err("Set a password before adding a username — a username alone isn't a login".to_string());
    }

    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "INSERT INTO folder_shares (id, folder_id, folder_name, permissions, password_hash, username, expires_at, revoked, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)"
    ).map_err(|e| e.to_string())?;
    stmt.bind((1, token.as_str())).map_err(|e| e.to_string())?;
    stmt.bind((2, folder_id)).map_err(|e| e.to_string())?;
    stmt.bind((3, folder_name.as_str())).map_err(|e| e.to_string())?;
    stmt.bind((4, permissions.bits())).map_err(|e| e.to_string())?;
    stmt.bind((5, password_hash.as_deref())).map_err(|e| e.to_string())?;
    stmt.bind((6, username.as_deref())).map_err(|e| e.to_string())?;
    stmt.bind((7, expires_at)).map_err(|e| e.to_string())?;
    stmt.bind((8, created_at)).map_err(|e| e.to_string())?;
    stmt.next().map_err(|e| e.to_string())?;

    let link = format!("{}/s/{}", share_base_url(&app), token);

    Ok(FolderShareInfo {
        id: token,
        folder_id,
        folder_name,
        can_upload,
        can_download,
        can_update,
        can_delete,
        has_password: password_hash.is_some(),
        username,
        expires_at,
        revoked: false,
        created_at,
        link,
    })
}

#[tauri::command]
pub async fn cmd_list_folder_shares(
    db_pool: State<'_, DbConnection>,
    app: AppHandle,
) -> Result<Vec<FolderShareInfo>, String> {
    let base_url = share_base_url(&app);
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, folder_id, folder_name, permissions, password_hash, username, expires_at, created_at
             FROM folder_shares WHERE revoked = 0 ORDER BY created_at DESC"
        )
        .map_err(|e| e.to_string())?;

    let mut shares = Vec::new();
    while let sqlite::State::Row = stmt.next().map_err(|e| e.to_string())? {
        let id = stmt.read::<String, _>("id").map_err(|e| e.to_string())?;
        let folder_id = stmt.read::<Option<i64>, _>("folder_id").ok().flatten();
        let folder_name = stmt.read::<String, _>("folder_name").map_err(|e| e.to_string())?;
        let raw_permissions = stmt.read::<i64, _>("permissions").map_err(|e| e.to_string())?;
        let permissions = SharePermissions::from_bits_truncate(raw_permissions);
        let has_password = stmt.read::<Option<String>, _>("password_hash").ok().flatten().is_some();
        let username = stmt.read::<Option<String>, _>("username").ok().flatten();
        let expires_at = stmt.read::<Option<i64>, _>("expires_at").ok().flatten();
        let created_at = stmt.read::<i64, _>("created_at").map_err(|e| e.to_string())?;
        let link = format!("{}/s/{}", base_url, id);

        shares.push(FolderShareInfo {
            id,
            folder_id,
            folder_name,
            can_upload: permissions.contains(SharePermissions::UPLOAD),
            can_download: permissions.contains(SharePermissions::DOWNLOAD),
            can_update: permissions.contains(SharePermissions::UPDATE),
            can_delete: permissions.contains(SharePermissions::DELETE),
            has_password,
            username,
            expires_at,
            revoked: false,
            created_at,
            link,
        });
    }

    Ok(shares)
}

#[tauri::command]
pub async fn cmd_revoke_folder_share(
    id: String,
    db_pool: State<'_, DbConnection>,
) -> Result<(), String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("UPDATE folder_shares SET revoked = 1 WHERE id = ?").map_err(|e| e.to_string())?;
    stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
    stmt.next().map_err(|e| e.to_string())?;

    Ok(())
}

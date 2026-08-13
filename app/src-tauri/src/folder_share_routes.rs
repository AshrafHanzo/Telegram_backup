//! HTTP routes for the "Temp Link Generator" feature: permissioned,
//! folder-scoped share links (`folder_shares` table). Unlike the legacy
//! single-file `/d/{token}` routes (`share_routes.rs`), a `/s/{token}` link
//! can grant an anonymous holder any combination of upload/download/update/
//! delete access to one Telegram folder — every route re-checks its own
//! required permission bit against the database record on every request;
//! none of them trust the frontend to have hidden a disabled control.

use actix_multipart::Multipart;
use actix_web::{cookie::Cookie, delete, get, post, put, web, HttpRequest, HttpResponse, Responder};
use futures::{StreamExt, TryStreamExt};
use grammers_client::types::{Media, Peer};
use grammers_client::InputMessage;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

use crate::bandwidth::BandwidthManager;
use crate::commands::utils::{map_error, resolve_peer};
use crate::commands::TelegramState;
use crate::db::DbConnection;
use crate::share_common::{escape_html, generate_cookie_val, verify_cookie_val, verify_password, VerifyRateLimiter};
use crate::share_permissions::SharePermissions;
use crate::vpn_optimizer::NetworkConfig;

/// Anonymous link holders have no bandwidth-manager-independent size limit
/// today, unlike the API-key-gated `api_upload_file`, which only ever
/// receives requests from a caller who already holds a secret. A hard cap
/// enforced *during* the streaming read (not after full buffering) bounds
/// the damage a bare link can do.
const MAX_SHARE_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone)]
struct FolderShareRow {
    folder_id: Option<i64>,
    folder_name: String,
    permissions: SharePermissions,
    password_hash: Option<String>,
    /// Optional login username required alongside the password. Not itself
    /// a secret — checked with a plain (trimmed) comparison, unlike
    /// `password_hash` which is bcrypt-hashed.
    username: Option<String>,
    expires_at: Option<i64>,
    revoked: bool,
}

#[derive(Deserialize)]
struct VerifyForm {
    username: Option<String>,
    password: String,
}

#[derive(Serialize)]
struct FolderShareFileEntry {
    message_id: i32,
    name: String,
    size: i64,
    mime_type: Option<String>,
    created_at: i64,
}

fn get_folder_share_by_token(db: &DbConnection, token: &str) -> Result<Option<FolderShareRow>, String> {
    let conn = db.lock().map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT folder_id, folder_name, permissions, password_hash, username, expires_at, revoked
             FROM folder_shares WHERE id = ?",
        )
        .map_err(|error| error.to_string())?;
    stmt.bind((1, token)).map_err(|error| error.to_string())?;

    if let sqlite::State::Row = stmt.next().map_err(|error| error.to_string())? {
        let folder_id = stmt.read::<Option<i64>, _>("folder_id").ok().flatten();
        let folder_name = stmt.read::<String, _>("folder_name").map_err(|error| error.to_string())?;
        let raw_permissions = stmt.read::<i64, _>("permissions").map_err(|error| error.to_string())?;
        let password_hash = stmt.read::<Option<String>, _>("password_hash").ok().flatten();
        let username = stmt.read::<Option<String>, _>("username").ok().flatten();
        let expires_at = stmt.read::<Option<i64>, _>("expires_at").ok().flatten();
        let revoked = stmt.read::<i64, _>("revoked").map_err(|error| error.to_string())? != 0;

        Ok(Some(FolderShareRow {
            folder_id,
            folder_name,
            permissions: SharePermissions::from_bits_truncate(raw_permissions),
            password_hash,
            username,
            expires_at,
            revoked,
        }))
    } else {
        Ok(None)
    }
}

/// True if `message_id` is a registered encrypted/vault-protected file.
/// Folder shares must never expose these — not even their existence — to an
/// anonymous link holder, regardless of which permissions the link grants.
pub(crate) fn is_encrypted_message(db: &DbConnection, folder_id: Option<i64>, message_id: i32) -> bool {
    let folder_key = folder_id.map(|id| id.to_string()).unwrap_or_else(|| "home".to_string());
    let conn = match db.lock() {
        Ok(conn) => conn,
        Err(_) => return true, // Fail closed on a poisoned lock.
    };
    let mut stmt = match conn.prepare(
        "SELECT 1 FROM encrypted_files WHERE folder_key = ? AND message_id = ? AND record_state = 'active'",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return false,
    };
    if stmt.bind((1, folder_key.as_str())).is_err() || stmt.bind((2, message_id as i64)).is_err() {
        return false;
    }
    matches!(stmt.next(), Ok(sqlite::State::Row))
}

/// Every data route funnels through here: resolves the token, checks
/// revoked/expired/password, and — the part that actually matters for this
/// feature — re-checks `required` against the row's own permission bits.
/// A route that skips this check (or trusts a disabled frontend button
/// instead) is exactly the kind of bug this feature can't ship with.
async fn authorize_folder_share(
    req: &HttpRequest,
    token: &str,
    required: SharePermissions,
    db: &DbConnection,
) -> Result<FolderShareRow, HttpResponse> {
    let row = match get_folder_share_by_token(db, token) {
        Ok(Some(row)) => row,
        Ok(None) => return Err(HttpResponse::NotFound().body("Shared link not found")),
        Err(error) => {
            log::error!("DB error resolving folder share token {}: {}", token, error);
            return Err(HttpResponse::InternalServerError().body("Internal server error"));
        }
    };

    if row.revoked {
        return Err(HttpResponse::NotFound().body("This shared link has been revoked"));
    }
    if let Some(expiry) = row.expires_at {
        if expiry < chrono::Utc::now().timestamp() {
            return Err(HttpResponse::Gone().body("This shared link has expired"));
        }
    }
    if let Some(hash) = &row.password_hash {
        let authenticated = req
            .cookie(&format!("folder_share_auth_{}", token))
            .is_some_and(|cookie| verify_cookie_val(cookie.value(), token, hash, 30 * 60));
        if !authenticated {
            return Err(render_password_page(req, &row.folder_name, token, row.username.is_some(), None));
        }
    }
    if !row.permissions.contains(required) {
        return Err(HttpResponse::Forbidden().body("This link does not grant that permission"));
    }

    Ok(row)
}

fn render_password_page(
    _req: &HttpRequest,
    folder_name: &str,
    token: &str,
    requires_username: bool,
    error: Option<&str>,
) -> HttpResponse {
    let safe_name = escape_html(folder_name);
    let error_html = if error.is_some() {
        "<div class=\"error\">Incorrect username or password. Please try again.</div>"
    } else {
        ""
    };
    let username_field = if requires_username {
        r#"<input type="text" name="username" placeholder="Username" autocomplete="username" autofocus required>"#
    } else {
        ""
    };
    let heading = if requires_username { "Log In" } else { "Enter Password" };
    let description = if requires_username {
        "This shared folder requires a username and password."
    } else {
        "This shared folder is password-protected."
    };
    let password_autofocus = if requires_username { "" } else { "autofocus " };
    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Password Protected Folder - Telegram Drive</title>
    <style>
        body {{ background:#182533; color:#fff; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }}
        .container {{ background:#202b36; padding:2rem; border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.2); border:1px solid #2f3e4e; width:100%; max-width:400px; text-align:center; }}
        h2 {{ margin-top:0; color:#40a7e3; }}
        p {{ font-size:14px; color:#7f91a4; margin-bottom:20px; }}
        input[type="text"], input[type="password"] {{ width:100%; padding:12px; border-radius:6px; border:1px solid #2f3e4e; background:#182533; color:#fff; box-sizing:border-box; margin-bottom:15px; font-size:16px; }}
        button {{ width:100%; padding:12px; border-radius:6px; border:none; background:#40a7e3; color:#fff; font-weight:bold; cursor:pointer; font-size:16px; }}
        .error {{ color:#ff5e5e; font-size:14px; margin-bottom:15px; }}
    </style>
</head>
<body>
    <div class="container">
        <h2>{}</h2>
        <p>{}<br>Folder: <strong><bdi dir="auto">{}</bdi></strong></p>
        {}
        <form method="POST" action="/s/{}/verify">
            {}
            <input type="password" name="password" placeholder="Password" {}required>
            <button type="submit">Verify</button>
        </form>
    </div>
</body>
</html>"#,
        heading, description, safe_name, error_html, token, username_field, password_autofocus
    );
    HttpResponse::Ok().content_type("text/html; charset=utf-8").body(html)
}

#[post("/s/{token}/verify")]
async fn verify_folder_share_password(
    req: HttpRequest,
    path: web::Path<String>,
    form: web::Form<VerifyForm>,
    db_conn: web::Data<DbConnection>,
    rate_limiter: web::Data<Arc<VerifyRateLimiter>>,
) -> impl Responder {
    let token = path.into_inner();
    if !rate_limiter.check_and_record(&token) {
        return HttpResponse::TooManyRequests().body("Too many attempts. Please try again later.");
    }

    let row = match get_folder_share_by_token(&db_conn, &token) {
        Ok(Some(row)) => row,
        Ok(None) => return HttpResponse::NotFound().body("Shared link not found"),
        Err(error) => {
            log::error!("DB error resolving folder share token {}: {}", token, error);
            return HttpResponse::InternalServerError().body("Internal server error");
        }
    };
    if row.revoked {
        return HttpResponse::NotFound().body("This shared link has been revoked");
    }
    let hash = match &row.password_hash {
        Some(hash) => hash,
        None => return HttpResponse::BadRequest().body("No password required for this link"),
    };

    let username_ok = match &row.username {
        Some(expected) => {
            let provided = form.username.as_deref().map(str::trim).unwrap_or("");
            constant_time_eq::constant_time_eq(provided.as_bytes(), expected.as_bytes())
        }
        None => true,
    };

    // Always run verify_password (bcrypt, ~50-150ms) regardless of whether
    // the username matched — short-circuiting on `username_ok` would let a
    // caller learn the correct username (for a link that requires one) just
    // by timing how long a wrong-username-any-password request takes versus
    // a right-username-wrong-password one, before ever needing to guess the
    // real password.
    let password_ok = verify_password(&form.password, hash);

    if username_ok && password_ok {
        let value = generate_cookie_val(&token, hash, chrono::Utc::now().timestamp());
        let cookie = Cookie::build(format!("folder_share_auth_{}", token), value)
            .path(format!("/s/{}", token))
            .http_only(true)
            .same_site(actix_web::cookie::SameSite::Strict)
            .max_age(actix_web::cookie::time::Duration::minutes(30))
            .finish();
        HttpResponse::Found()
            .insert_header(("Location", format!("/s/{}", token)))
            .cookie(cookie)
            .finish()
    } else {
        render_password_page(&req, &row.folder_name, &token, row.username.is_some(), Some("bad credentials"))
    }
}

/// Human-facing entry point: password gate, then a plain listing with
/// download links and, if granted, an inline upload form and delete buttons.
#[get("/s/{token}")]
async fn folder_share_page(
    req: HttpRequest,
    path: web::Path<String>,
    db_conn: web::Data<DbConnection>,
    tg_state: web::Data<Arc<TelegramState>>,
) -> impl Responder {
    let token = path.into_inner();
    // The page itself only requires the share to exist/not be
    // password-locked; individual actions on it are gated by their own
    // routes, which is where the real permission enforcement happens.
    let row = match authorize_folder_share(&req, &token, SharePermissions::empty(), &db_conn).await {
        Ok(row) => row,
        Err(response) => return response,
    };

    let client_opt = { tg_state.client.lock().await.clone() };
    let Some(client) = client_opt else {
        return HttpResponse::ServiceUnavailable().body("Telegram client is not connected");
    };

    let entries = if row.permissions.contains(SharePermissions::DOWNLOAD) {
        match list_folder_share_files(&client, &db_conn, &tg_state, row.folder_id).await {
            Ok(entries) => entries,
            Err(error) => return HttpResponse::InternalServerError().body(error),
        }
    } else {
        Vec::new()
    };

    let rows_html: String = entries
        .iter()
        .map(|entry| {
            let name = escape_html(&entry.name);
            let mut actions = format!(
                r#"<a class="btn" href="/s/{token}/files/{id}">Download</a>"#,
                token = token, id = entry.message_id
            );
            if row.permissions.contains(SharePermissions::DELETE) {
                actions.push_str(&format!(
                    r#" <button class="btn danger" onclick="del({})">Delete</button>"#,
                    entry.message_id
                ));
            }
            format!(
                r#"<tr><td><bdi dir="auto">{}</bdi></td><td>{}</td><td>{}</td></tr>"#,
                name,
                format_bytes(entry.size as u64),
                actions
            )
        })
        .collect();

    let upload_html = if row.permissions.contains(SharePermissions::UPLOAD) {
        format!(
            r#"<form method="POST" action="/s/{token}/files" enctype="multipart/form-data" class="upload">
                <input type="file" name="file" required>
                <button class="btn" type="submit">Upload</button>
            </form>"#,
            token = token
        )
    } else {
        String::new()
    };

    let delete_script = if row.permissions.contains(SharePermissions::DELETE) {
        format!(
            r#"<script>
                function del(id) {{
                    if (!confirm('Delete this file?')) return;
                    fetch('/s/{token}/files/' + id, {{ method: 'DELETE' }})
                        .then(() => location.reload());
                }}
            </script>"#,
            token = token
        )
    } else {
        String::new()
    };

    let safe_folder_name = escape_html(&row.folder_name);
    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>{name} - Shared Folder - Telegram Drive</title>
    <style>
        body {{ background:#182533; color:#fff; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; margin:0; padding:2rem; }}
        .wrap {{ max-width:720px; margin:0 auto; }}
        h1 {{ color:#40a7e3; font-size:1.25rem; }}
        table {{ width:100%; border-collapse:collapse; margin-top:1rem; }}
        td {{ padding:0.6rem 0.4rem; border-bottom:1px solid #2f3e4e; font-size:0.9rem; }}
        .btn {{ display:inline-block; padding:0.35rem 0.8rem; border-radius:6px; background:#40a7e3; color:#fff; text-decoration:none; border:none; cursor:pointer; font-size:0.85rem; }}
        .btn.danger {{ background:#c0392b; }}
        .upload {{ margin-top:1.5rem; display:flex; gap:0.5rem; }}
        .empty {{ color:#7f91a4; padding:1rem 0; }}
    </style>
</head>
<body>
    <div class="wrap">
        <h1>Shared folder: <bdi dir="auto">{name}</bdi></h1>
        {table}
        {upload}
    </div>
    {script}
</body>
</html>"#,
        name = safe_folder_name,
        table = if entries.is_empty() {
            r#"<p class="empty">No files to show.</p>"#.to_string()
        } else {
            format!("<table>{}</table>", rows_html)
        },
        upload = upload_html,
        script = delete_script,
    );
    HttpResponse::Ok().content_type("text/html; charset=utf-8").body(html)
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    format!("{:.1} {}", size, UNITS[unit])
}

async fn list_folder_share_files(
    client: &grammers_client::Client,
    db_conn: &DbConnection,
    tg_state: &TelegramState,
    folder_id: Option<i64>,
) -> Result<Vec<FolderShareFileEntry>, String> {
    let peer = resolve_peer(client, folder_id, &tg_state.peer_cache).await?;
    let mut messages = client.iter_messages(&peer);
    let mut entries = Vec::new();
    let mut last_id: Option<i32> = None;
    const MAX_ENTRIES: usize = 10_000;

    while let Some(message) = messages.next().await.map_err(|error| error.to_string())? {
        let current_id = message.id();
        if last_id == Some(current_id) {
            break;
        }
        last_id = Some(current_id);
        if entries.len() >= MAX_ENTRIES {
            break;
        }

        let Some(media) = message.media() else { continue };
        if is_encrypted_message(db_conn, folder_id, current_id) {
            continue;
        }
        let (name, size, mime_type) = match &media {
            Media::Document(document) => (
                document.name().to_string(),
                document.size(),
                document.mime_type().map(|value| value.to_string()),
            ),
            Media::Photo(_) => ("Photo.jpg".to_string(), 0, Some("image/jpeg".to_string())),
            _ => continue,
        };
        // A rename via caption (same convention `cmd_get_files` uses) should
        // still be reflected in the shared listing.
        let caption = message.text();
        let display_name = if caption.is_empty() { name } else { caption.to_string() };

        entries.push(FolderShareFileEntry {
            message_id: current_id,
            name: display_name,
            size,
            mime_type,
            created_at: message.date().timestamp(),
        });
    }
    Ok(entries)
}

#[get("/s/{token}/files")]
async fn list_files_json(
    req: HttpRequest,
    path: web::Path<String>,
    db_conn: web::Data<DbConnection>,
    tg_state: web::Data<Arc<TelegramState>>,
) -> impl Responder {
    let token = path.into_inner();
    let row = match authorize_folder_share(&req, &token, SharePermissions::DOWNLOAD, &db_conn).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let client_opt = { tg_state.client.lock().await.clone() };
    let Some(client) = client_opt else {
        return HttpResponse::ServiceUnavailable().body("Telegram client is not connected");
    };
    match list_folder_share_files(&client, &db_conn, &tg_state, row.folder_id).await {
        Ok(entries) => HttpResponse::Ok().json(entries),
        Err(error) => HttpResponse::InternalServerError().body(error),
    }
}

#[get("/s/{token}/files/{message_id}")]
async fn download_file(
    req: HttpRequest,
    path: web::Path<(String, i32)>,
    db_conn: web::Data<DbConnection>,
    tg_state: web::Data<Arc<TelegramState>>,
) -> impl Responder {
    let (token, message_id) = path.into_inner();
    let row = match authorize_folder_share(&req, &token, SharePermissions::DOWNLOAD, &db_conn).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    if is_encrypted_message(&db_conn, row.folder_id, message_id) {
        return HttpResponse::NotFound().body("File not found");
    }

    let client_opt = { tg_state.client.lock().await.clone() };
    let Some(client) = client_opt else {
        return HttpResponse::ServiceUnavailable().body("Telegram client is not connected");
    };
    // Peer is resolved from the share's own folder_id, never from anything
    // the caller supplies — a guessed message_id from a different channel
    // can never be fetched through this route.
    let peer = match resolve_peer(&client, row.folder_id, &tg_state.peer_cache).await {
        Ok(peer) => peer,
        Err(error) => {
            log::error!("Failed to resolve peer for folder share: {}", error);
            return HttpResponse::InternalServerError().body("Failed to locate folder");
        }
    };

    match client.get_messages_by_id(peer, &[message_id]).await {
        Ok(messages) => {
            if let Some(Some(message)) = messages.first() {
                if let Some(media) = message.media() {
                    let mime = match &media {
                        Media::Document(document) => document.mime_type().unwrap_or("application/octet-stream").to_string(),
                        _ => "application/octet-stream".to_string(),
                    };
                    return crate::server::build_media_response(
                        &client, &media, &req, &mime, None,
                        crate::server::StreamingExtras { extra_headers: vec![], log_label: "Folder share download" },
                    );
                }
            }
            HttpResponse::NotFound().body("Message or media not found")
        }
        Err(error) => {
            log::error!("Failed to fetch folder-share message {}: {}", message_id, error);
            HttpResponse::InternalServerError().body(format!("Failed to retrieve file: {}", error))
        }
    }
}

/// Strips characters illegal in filenames across platforms, trims trailing
/// dots/spaces, and guards against Windows reserved device names — kept as
/// a small local copy of `webdav.rs`'s `sanitize_name` rather than importing
/// it, since that module is compiled out on Android/iOS and this one isn't.
fn sanitize_filename(name: &str) -> String {
    let mut sanitized: String = name
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect();
    while sanitized.ends_with(['.', ' ']) {
        sanitized.pop();
    }
    if sanitized.is_empty() {
        sanitized.push_str("Untitled");
    }
    let stem = sanitized.split('.').next().unwrap_or(&sanitized).to_ascii_uppercase();
    let is_reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .and_then(|number| number.parse::<u8>().ok())
            .is_some_and(|number| (1..=9).contains(&number));
    if is_reserved {
        sanitized.insert(0, '_');
    }
    if sanitized.chars().count() > 240 {
        sanitized = sanitized.chars().take(240).collect();
    }
    sanitized
}

/// Buffers a single `multipart/form-data` field named `file` to a temp file,
/// aborting (and cleaning up) if it exceeds `MAX_SHARE_UPLOAD_BYTES` — the
/// cap is enforced while streaming, not after the whole body is buffered.
async fn receive_upload(mut payload: Multipart) -> Result<(String, std::path::PathBuf, u64), HttpResponse> {
    let temp_path = std::env::temp_dir().join(format!(
        "share_upload_{}_{}",
        rand::random::<u32>(),
        rand::random::<u32>()
    ));
    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|error| HttpResponse::InternalServerError().body(error.to_string()))?;

    let mut filename = "file".to_string();
    let mut total: u64 = 0;

    while let Ok(Some(mut field)) = payload.try_next().await {
        let content_disposition = field.content_disposition();
        let field_name = content_disposition.and_then(|cd| cd.get_name()).unwrap_or("");
        if field_name != "file" {
            continue;
        }
        if let Some(name) = content_disposition.and_then(|cd| cd.get_filename()) {
            filename = sanitize_filename(name);
        }
        while let Some(chunk) = field.next().await {
            let data = match chunk {
                Ok(data) => data,
                Err(error) => {
                    let _ = tokio::fs::remove_file(&temp_path).await;
                    return Err(HttpResponse::BadRequest().body(error.to_string()));
                }
            };
            total += data.len() as u64;
            if total > MAX_SHARE_UPLOAD_BYTES {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(HttpResponse::PayloadTooLarge().body("File exceeds the maximum allowed size"));
            }
            if let Err(error) = file.write_all(&data).await {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(HttpResponse::InternalServerError().body(error.to_string()));
            }
        }
    }
    if let Err(error) = file.flush().await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(HttpResponse::InternalServerError().body(error.to_string()));
    }
    drop(file);

    Ok((filename, temp_path, total))
}

async fn send_temp_file_to_telegram(
    client: &grammers_client::Client,
    peer: &Peer,
    net_config: &NetworkConfig,
    filename: String,
    temp_path: &std::path::Path,
    size: u64,
) -> Result<i32, String> {
    let mut open_file = tokio::fs::File::open(temp_path).await.map_err(|error| error.to_string())?;
    let uploaded_file = client
        .upload_stream(&mut open_file, size as usize, filename)
        .await
        .map_err(map_error)?;
    let message = InputMessage::new().text("").file(uploaded_file);

    let max_retries = net_config.retry_attempts();
    let base_ms = net_config.retry_base_backoff_ms();
    let max_ms = net_config.retry_max_backoff_ms();
    let respect_flood = net_config.should_respect_flood_wait();
    let mut last_err = String::new();

    for attempt in 0..=max_retries {
        match client.send_message(peer, message.clone()).await {
            Ok(sent) => return Ok(sent.id()),
            Err(error) => {
                let err = map_error(error);
                if respect_flood && err.starts_with("FLOOD_WAIT_") {
                    if let Ok(secs) = err.trim_start_matches("FLOOD_WAIT_").parse::<u64>() {
                        tokio::time::sleep(std::time::Duration::from_secs(secs.min(300))).await;
                        last_err = err;
                        continue;
                    }
                }
                if attempt < max_retries {
                    let wait = crate::vpn_optimizer::backoff_ms(attempt, base_ms, max_ms);
                    tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
                }
                last_err = err;
            }
        }
    }
    Err(format!("Upload failed after {} attempts: {}", max_retries + 1, last_err))
}

#[post("/s/{token}/files")]
async fn upload_file(
    req: HttpRequest,
    path: web::Path<String>,
    payload: Multipart,
    db_conn: web::Data<DbConnection>,
    tg_state: web::Data<Arc<TelegramState>>,
    bw_manager: web::Data<Arc<BandwidthManager>>,
    net_config: web::Data<Arc<NetworkConfig>>,
) -> impl Responder {
    let token = path.into_inner();
    let row = match authorize_folder_share(&req, &token, SharePermissions::UPLOAD, &db_conn).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    let client_opt = { tg_state.client.lock().await.clone() };
    let Some(client) = client_opt else {
        return HttpResponse::ServiceUnavailable().body("Telegram client is not connected");
    };

    let (filename, temp_path, size) = match receive_upload(payload).await {
        Ok(result) => result,
        Err(response) => return response,
    };

    if let Err(error) = bw_manager.try_reserve_up(size) {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return HttpResponse::BadRequest().body(error);
    }
    let peer = match resolve_peer(&client, row.folder_id, &tg_state.peer_cache).await {
        Ok(peer) => peer,
        Err(error) => {
            bw_manager.release_up(size);
            let _ = tokio::fs::remove_file(&temp_path).await;
            return HttpResponse::InternalServerError().body(error);
        }
    };

    let result = send_temp_file_to_telegram(&client, &peer, &net_config, filename, &temp_path, size).await;
    let _ = tokio::fs::remove_file(&temp_path).await;

    match result {
        Ok(message_id) => HttpResponse::Ok().json(serde_json::json!({ "message_id": message_id })),
        Err(error) => {
            bw_manager.release_up(size);
            HttpResponse::InternalServerError().body(error)
        }
    }
}

/// "Update" replaces the content of a caller-specified `message_id` (the
/// link holder discovers ids via the list route) rather than overwriting
/// by filename, which would be ambiguous with duplicate names. The new
/// content is uploaded before the old message is deleted, so a failure
/// partway through never loses data.
#[put("/s/{token}/files/{message_id}")]
async fn update_file(
    req: HttpRequest,
    path: web::Path<(String, i32)>,
    payload: Multipart,
    db_conn: web::Data<DbConnection>,
    tg_state: web::Data<Arc<TelegramState>>,
    bw_manager: web::Data<Arc<BandwidthManager>>,
    net_config: web::Data<Arc<NetworkConfig>>,
) -> impl Responder {
    let (token, old_message_id) = path.into_inner();
    let row = match authorize_folder_share(&req, &token, SharePermissions::UPDATE, &db_conn).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    if is_encrypted_message(&db_conn, row.folder_id, old_message_id) {
        return HttpResponse::NotFound().body("File not found");
    }

    let client_opt = { tg_state.client.lock().await.clone() };
    let Some(client) = client_opt else {
        return HttpResponse::ServiceUnavailable().body("Telegram client is not connected");
    };
    let peer = match resolve_peer(&client, row.folder_id, &tg_state.peer_cache).await {
        Ok(peer) => peer,
        Err(error) => return HttpResponse::InternalServerError().body(error),
    };
    // Verify the message actually exists in this share's folder before
    // accepting the upload — otherwise a caller could "update" a message_id
    // from a different channel that just happens to be a valid integer.
    match client.get_messages_by_id(peer.clone(), &[old_message_id]).await {
        Ok(messages) if messages.iter().flatten().next().is_some() => {}
        _ => return HttpResponse::NotFound().body("File not found in this shared folder"),
    }

    let (filename, temp_path, size) = match receive_upload(payload).await {
        Ok(result) => result,
        Err(response) => return response,
    };
    if let Err(error) = bw_manager.try_reserve_up(size) {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return HttpResponse::BadRequest().body(error);
    }

    let result = send_temp_file_to_telegram(&client, &peer, &net_config, filename, &temp_path, size).await;
    let _ = tokio::fs::remove_file(&temp_path).await;

    let new_message_id = match result {
        Ok(id) => id,
        Err(error) => {
            bw_manager.release_up(size);
            return HttpResponse::InternalServerError().body(error);
        }
    };

    if let Err(error) = client.delete_messages(&peer, &[old_message_id]).await {
        log::warn!(
            "Folder share update: uploaded replacement {} but failed to delete old message {}: {}",
            new_message_id, old_message_id, error
        );
    }

    HttpResponse::Ok().json(serde_json::json!({ "message_id": new_message_id }))
}

#[delete("/s/{token}/files/{message_id}")]
async fn delete_file(
    req: HttpRequest,
    path: web::Path<(String, i32)>,
    db_conn: web::Data<DbConnection>,
    tg_state: web::Data<Arc<TelegramState>>,
) -> impl Responder {
    let (token, message_id) = path.into_inner();
    let row = match authorize_folder_share(&req, &token, SharePermissions::DELETE, &db_conn).await {
        Ok(row) => row,
        Err(response) => return response,
    };
    if is_encrypted_message(&db_conn, row.folder_id, message_id) {
        return HttpResponse::NotFound().body("File not found");
    }

    let client_opt = { tg_state.client.lock().await.clone() };
    let Some(client) = client_opt else {
        return HttpResponse::ServiceUnavailable().body("Telegram client is not connected");
    };
    let peer = match resolve_peer(&client, row.folder_id, &tg_state.peer_cache).await {
        Ok(peer) => peer,
        Err(error) => return HttpResponse::InternalServerError().body(error),
    };
    match client.delete_messages(&peer, &[message_id]).await {
        Ok(_) => HttpResponse::Ok().finish(),
        Err(error) => HttpResponse::InternalServerError().body(error.to_string()),
    }
}

pub fn configure_folder_share_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(folder_share_page)
        .service(verify_folder_share_password)
        .service(list_files_json)
        .service(download_file)
        .service(upload_file)
        .service(update_file)
        .service(delete_file);
}

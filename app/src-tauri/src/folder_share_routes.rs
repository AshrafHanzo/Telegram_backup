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
use crate::split_file;
use crate::vpn_optimizer::NetworkConfig;

/// Anonymous link holders have no bandwidth-manager-independent size limit
/// today, unlike the API-key-gated `api_upload_file`, which only ever
/// receives requests from a caller who already holds a secret. A hard cap
/// enforced *during* the streaming read (not after full buffering) bounds
/// the damage a bare link can do.
///
/// Not Telegram's per-message limit — uploads over that are automatically
/// split into parts (see `split_file`), same as the desktop app's own
/// upload path. This is purely a generic anti-abuse ceiling for an
/// anonymous, unauthenticated-by-default link.
const MAX_SHARE_UPLOAD_BYTES: u64 = 50 * 1024 * 1024 * 1024;

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

    // Real Telegram-embedded thumbnails (`download_file_thumbnail` route)
    // are only attempted for categories that actually tend to have one —
    // image and video — everything else just gets its category icon
    // directly, no wasted request for a thumbnail that (almost) never
    // exists. If a thumbnail request 404s/fails anyway, `onerror` hides the
    // broken `<img>` and the icon underneath (`.file-icon`, absolutely
    // positioned behind it) shows through — no JS-side icon-swapping needed.
    let cards_html: String = entries
        .iter()
        .map(|entry| {
            let name = escape_html(&entry.name);
            let category = file_type_category(&entry.name, entry.mime_type.as_deref());
            let icon_svg = file_type_icon_svg(category);
            let thumb_inner = if category == "image" || category == "video" {
                format!(
                    r#"<div class="file-icon">{icon}</div><img src="/s/{token}/files/{id}/thumbnail" loading="lazy" alt="" onerror="this.style.display='none'">"#,
                    icon = icon_svg, token = token, id = entry.message_id
                )
            } else {
                format!(r#"<div class="file-icon">{}</div>"#, icon_svg)
            };

            let mut actions = format!(
                r#"<a class="btn primary-soft" href="/s/{token}/files/{id}">{icon}Download</a>"#,
                token = token, id = entry.message_id, icon = ICON_DOWNLOAD
            );
            if row.permissions.contains(SharePermissions::DELETE) {
                actions.push_str(&format!(
                    r#"<button class="btn icon" onclick="del({id})" title="Delete" aria-label="Delete {name}">{icon}</button>"#,
                    id = entry.message_id, name = name, icon = ICON_TRASH
                ));
            }

            format!(
                r#"<div class="file-card"><div class="file-thumb">{thumb}</div><div class="file-body"><div class="file-name" title="{name}"><bdi dir="auto">{name}</bdi></div><div class="file-size">{size}</div></div><div class="file-actions">{actions}</div></div>"#,
                thumb = thumb_inner,
                name = name,
                size = format_bytes(entry.size as u64),
                actions = actions,
            )
        })
        .collect();

    // The plain `<form enctype="multipart/form-data">` this used to be
    // submits as a real browser navigation — the server's JSON response
    // (`{"message_id": ...}`) would replace the whole page, with zero
    // upload-progress feedback along the way. `UPLOAD_SCRIPT_TEMPLATE`
    // below replaces that with `XMLHttpRequest` (its `upload.onprogress`
    // event is what a plain `fetch()` still can't give us), styled and
    // laid out to match the desktop app's own `UploadQueue.tsx` — same
    // thin rounded progress bar, same "Uploading: X / Y" + speed line —
    // plus an aggregate total/ETA/elapsed row `UploadQueue` doesn't need
    // (it shows separate per-file cards, not one combined upload).
    let upload_html = if row.permissions.contains(SharePermissions::UPLOAD) {
        format!(
            r##"<section class="section">
            <div class="section-label">Upload</div>
            <div id="uploadZone" class="dropzone" role="button" tabindex="0" aria-label="Choose files to upload">
                <input type="file" id="fileInput" multiple hidden>
                <div class="dropzone-icon">{icon}</div>
                <div class="dropzone-title">Drop files here, or <span id="browseLink">browse</span></div>
                <div class="dropzone-sub">Uploaded straight to Telegram — large files are split automatically</div>
            </div>
            <div id="uploadProgressCard" class="progress-panel" style="display:none;">
                <div class="progress-head">
                    <div class="progress-top">
                        <div class="progress-pct" id="overallPercent">0%</div>
                        <div class="progress-bytes" id="overallStats">0 B / 0 B</div>
                    </div>
                    <div class="bar"><div class="bar-fill" id="overallBar"></div></div>
                    <div class="stat-row">
                        <div class="stat"><div class="stat-label">Speed</div><div class="stat-value" id="overallSpeed">&ndash;</div></div>
                        <div class="stat"><div class="stat-label">Remaining</div><div class="stat-value" id="overallEta">&ndash;</div></div>
                        <div class="stat"><div class="stat-label">Elapsed</div><div class="stat-value" id="overallElapsed">0s</div></div>
                    </div>
                </div>
                <div class="progress-list" id="fileProgressList"></div>
            </div>
        </section>"##,
            icon = ICON_UPLOAD
        )
    } else {
        String::new()
    };

    let mut script = String::new();
    if row.permissions.contains(SharePermissions::DELETE) {
        script.push_str(&format!(
            r#"<script>
                function del(id) {{
                    if (!confirm('Delete this file?')) return;
                    fetch('/s/{token}/files/' + id, {{ method: 'DELETE' }})
                        .then(() => location.reload());
                }}
            </script>"#,
            token = token
        ));
    }
    if row.permissions.contains(SharePermissions::UPLOAD) {
        script.push_str(&format!(
            "<script>{}</script>",
            UPLOAD_SCRIPT_TEMPLATE.replace("__TOKEN__", &token)
        ));
    }

    let safe_folder_name = escape_html(&row.folder_name);

    // Summary before detail: a link holder wants to know what's in here
    // before scanning individual cards.
    let total_bytes: u64 = entries.iter().map(|entry| entry.size.max(0) as u64).sum();
    let meta_chips = if entries.is_empty() {
        String::new()
    } else {
        format!(
            r#"<div class="folder-meta"><span class="chip">{count} {label}</span><span class="chip">{total} total</span></div>"#,
            count = entries.len(),
            label = if entries.len() == 1 { "file" } else { "files" },
            total = format_bytes(total_bytes),
        )
    };

    let listing = if entries.is_empty() {
        format!(
            r#"<div class="empty"><div class="empty-icon">{icon}</div><div class="empty-title">Nothing here yet</div><div class="empty-sub">{sub}</div></div>"#,
            icon = ICON_FOLDER,
            sub = if row.permissions.contains(SharePermissions::UPLOAD) {
                "Files added below will appear here."
            } else {
                "This folder is empty."
            },
        )
    } else {
        format!(
            r#"<section class="section"><div class="section-label">Files</div><div class="file-grid">{}</div></section>"#,
            cards_html
        )
    };

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>{name} — Telegram Drive</title>
    <style>{style}</style>
</head>
<body>
    <header class="topbar">
        <div class="topbar-inner">
            <div class="brand">
                <span class="brand-mark">{logo}</span>
                <span class="brand-name">Telegram Drive</span>
            </div>
            <span class="badge">Shared folder</span>
        </div>
    </header>
    <main class="wrap">
        <div class="folder-head">
            <div class="folder-eyebrow">Shared with you</div>
            <h1 class="folder-name"><bdi dir="auto">{name}</bdi></h1>
            {chips}
        </div>
        {listing}
        {upload}
        <div class="foot">Files are stored in Telegram and streamed on demand.</div>
    </main>
    {script}
</body>
</html>"#,
        name = safe_folder_name,
        style = SHARE_PAGE_CSS,
        logo = ICON_SHIELD,
        chips = meta_chips,
        listing = listing,
        upload = upload_html,
        script = script,
    );
    HttpResponse::Ok().content_type("text/html; charset=utf-8").body(html)
}

/// The desktop app's actual default-theme palette (`Default Dark` in
/// `src/theme/presets.ts`) — matched exactly so this server-rendered page
/// looks like part of the same app instead of a generic fallback page.
const SHARE_PAGE_CSS: &str = r#"
    /* Palette anchored to the desktop app's own "Default Dark" preset
       (src/theme/presets.ts) so a share link reads as the same product,
       extended with the raised-surface / hairline / shadow tokens a flat
       two-color set can't express. */
    :root {
        --canvas: #101114;
        --surface: #191a1f;
        --surface-raised: #20222a;
        --line: rgba(255,255,255,0.07);
        --line-strong: rgba(255,255,255,0.14);
        --accent: #2aabee;
        --accent-hover: #48b9f2;
        --accent-soft: rgba(42,171,238,0.12);
        --text: #f5f6f7;
        --text-2: #a8abb4;
        --text-3: #71757f;
        --ok: #3ddc84;
        --danger: #ff6b6b;
        --radius-lg: 16px;
        --radius: 12px;
        --radius-sm: 9px;
        --shadow: 0 1px 2px rgba(0,0,0,0.4), 0 10px 30px -12px rgba(0,0,0,0.7);
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
        margin: 0;
        min-height: 100vh;
        background: var(--canvas);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 15px;
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
    }
    /* Soft accent bloom behind the header for depth without a heavy hero. */
    body::before {
        content: "";
        position: fixed;
        inset: 0 0 auto 0;
        height: 380px;
        background: radial-gradient(ellipse 620px 220px at 50% -60px, rgba(42,171,238,0.13), transparent 70%);
        pointer-events: none;
        z-index: 0;
    }

    .topbar {
        position: sticky;
        top: 0;
        z-index: 10;
        background: rgba(16,17,20,0.82);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border-bottom: 1px solid var(--line);
    }
    .topbar-inner {
        max-width: 880px;
        margin: 0 auto;
        padding: 0.85rem 1.5rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
    }
    .brand { display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
    .brand-mark {
        width: 30px; height: 30px;
        flex-shrink: 0;
        border-radius: 9px;
        background: linear-gradient(150deg, var(--accent), #1d8fd0);
        display: flex; align-items: center; justify-content: center;
        color: #fff;
        box-shadow: 0 2px 10px -2px rgba(42,171,238,0.55);
    }
    .brand-mark svg { width: 17px; height: 17px; }
    .brand-name { font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em; }
    .badge {
        flex-shrink: 0;
        font-size: 0.68rem;
        font-weight: 600;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--accent);
        background: var(--accent-soft);
        border: 1px solid rgba(42,171,238,0.22);
        padding: 0.3rem 0.6rem;
        border-radius: 999px;
    }

    .wrap { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 2.25rem 1.5rem 4rem; }

    .folder-head { margin-bottom: 2.25rem; }
    .folder-eyebrow {
        font-size: 0.7rem; font-weight: 600; letter-spacing: 0.1em;
        text-transform: uppercase; color: var(--text-3); margin-bottom: 0.55rem;
    }
    .folder-name {
        margin: 0;
        font-size: 1.85rem;
        line-height: 1.15;
        font-weight: 650;
        letter-spacing: -0.02em;
        text-wrap: balance;
        word-break: break-word;
    }
    .folder-meta { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.9rem; }
    .chip {
        font-size: 0.76rem;
        color: var(--text-2);
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 0.28rem 0.7rem;
        font-variant-numeric: tabular-nums;
    }

    .section { margin-bottom: 2.25rem; }
    .section:last-child { margin-bottom: 0; }
    .section-label {
        font-size: 0.7rem; font-weight: 600; letter-spacing: 0.1em;
        text-transform: uppercase; color: var(--text-3);
        margin-bottom: 0.85rem;
        display: flex; align-items: center; gap: 0.5rem;
    }

    .file-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(178px, 1fr)); gap: 0.9rem; }
    .file-card {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: var(--radius-lg);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        box-shadow: var(--shadow);
        transition: transform 0.18s ease, border-color 0.18s ease;
    }
    .file-card:hover { transform: translateY(-2px); border-color: var(--line-strong); }
    .file-thumb {
        position: relative;
        aspect-ratio: 16 / 10;
        background: linear-gradient(155deg, var(--surface-raised), #15161a);
        border-bottom: 1px solid var(--line);
    }
    .file-thumb .file-icon { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
    .file-thumb .file-icon svg { width: 30px; height: 30px; }
    .file-thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
    .file-body { padding: 0.75rem 0.85rem 0; min-width: 0; }
    .file-name { font-size: 0.85rem; font-weight: 500; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-size { font-size: 0.75rem; color: var(--text-3); margin-top: 0.2rem; font-variant-numeric: tabular-nums; }
    .file-actions { display: flex; gap: 0.4rem; padding: 0.8rem 0.85rem 0.85rem; margin-top: auto; }

    .btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;
        font-family: inherit; font-size: 0.8rem; font-weight: 550;
        padding: 0.45rem 0.8rem;
        border-radius: var(--radius-sm);
        border: 1px solid transparent;
        background: var(--accent); color: #05202e;
        text-decoration: none; cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
        white-space: nowrap;
    }
    .btn svg { width: 14px; height: 14px; }
    .btn:hover { background: var(--accent-hover); }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .btn.primary-soft { flex: 1; background: var(--accent-soft); color: var(--accent); border-color: rgba(42,171,238,0.25); }
    .btn.primary-soft:hover { background: rgba(42,171,238,0.2); border-color: rgba(42,171,238,0.45); }
    .btn.icon { padding: 0.45rem; background: transparent; border-color: var(--line); color: var(--text-3); }
    .btn.icon:hover { color: var(--danger); border-color: rgba(255,107,107,0.4); background: rgba(255,107,107,0.08); }

    .empty {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: var(--radius-lg);
        padding: 3rem 1.5rem;
        text-align: center;
    }
    .empty-icon {
        width: 46px; height: 46px; margin: 0 auto 0.9rem;
        border-radius: 50%;
        background: var(--surface-raised);
        border: 1px solid var(--line);
        display: flex; align-items: center; justify-content: center;
        color: var(--text-3);
    }
    .empty-icon svg { width: 21px; height: 21px; }
    .empty-title { font-size: 0.92rem; font-weight: 550; }
    .empty-sub { font-size: 0.8rem; color: var(--text-3); margin-top: 0.25rem; }

    .dropzone {
        border: 1.5px dashed var(--line-strong);
        border-radius: var(--radius-lg);
        background: rgba(255,255,255,0.012);
        padding: 2.1rem 1.5rem;
        text-align: center;
        cursor: pointer;
        transition: border-color 0.18s ease, background 0.18s ease;
    }
    .dropzone:hover { border-color: rgba(42,171,238,0.45); background: rgba(42,171,238,0.04); }
    .dropzone.dragging { border-color: var(--accent); background: var(--accent-soft); }
    .dropzone:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .dropzone-icon {
        width: 44px; height: 44px; margin: 0 auto 0.85rem;
        border-radius: 12px;
        background: var(--accent-soft);
        border: 1px solid rgba(42,171,238,0.22);
        display: flex; align-items: center; justify-content: center;
        color: var(--accent);
    }
    .dropzone-icon svg { width: 20px; height: 20px; }
    .dropzone-title { font-size: 0.92rem; font-weight: 550; }
    .dropzone-title span { color: var(--accent); }
    .dropzone-sub { font-size: 0.78rem; color: var(--text-3); margin-top: 0.3rem; }

    .progress-panel {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: var(--radius-lg);
        overflow: hidden;
        box-shadow: var(--shadow);
    }
    .progress-head { padding: 1.1rem 1.15rem; border-bottom: 1px solid var(--line); }
    .progress-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; margin-bottom: 0.85rem; }
    .progress-pct { font-size: 1.9rem; font-weight: 650; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .progress-bytes { font-size: 0.8rem; color: var(--text-2); font-variant-numeric: tabular-nums; text-align: right; }
    .bar { width: 100%; height: 7px; background: rgba(255,255,255,0.07); border-radius: 999px; overflow: hidden; }
    .bar-fill { height: 100%; width: 0%; border-radius: 999px; background: linear-gradient(90deg, #1d8fd0, var(--accent)); transition: width 0.25s ease; }
    .bar.slim { height: 3px; margin-top: 0.45rem; }
    .stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-top: 1rem; }
    .stat { min-width: 0; }
    .stat-label { font-size: 0.64rem; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-3); }
    .stat-value { font-size: 0.85rem; color: var(--text); margin-top: 0.2rem; font-variant-numeric: tabular-nums; }

    .progress-list { max-height: 250px; overflow-y: auto; padding: 0.5rem; }
    .progress-row { padding: 0.6rem 0.65rem; border-radius: var(--radius); }
    .progress-row + .progress-row { margin-top: 0.15rem; }
    .progress-row:hover { background: rgba(255,255,255,0.03); }
    .progress-row-top { display: flex; justify-content: space-between; align-items: baseline; gap: 0.65rem; }
    .progress-row-name { font-size: 0.82rem; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .progress-row-state { font-size: 0.75rem; color: var(--text-3); flex-shrink: 0; font-variant-numeric: tabular-nums; }
    .progress-row-state.ok { color: var(--ok); }
    .progress-row-state.fail { color: var(--danger); }

    .foot { margin-top: 2.75rem; padding-top: 1.25rem; border-top: 1px solid var(--line); font-size: 0.75rem; color: var(--text-3); text-align: center; }

    @media (max-width: 560px) {
        .wrap { padding: 1.75rem 1.1rem 3rem; }
        .topbar-inner { padding: 0.75rem 1.1rem; }
        .folder-name { font-size: 1.5rem; }
        .file-grid { grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 0.7rem; }
        .stat-row { grid-template-columns: 1fr 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
        * { transition: none !important; }
        .file-card:hover { transform: none; }
    }
"#;

/// Drives multi-file uploads via `XMLHttpRequest` (its `upload.onprogress`
/// event is the only way to get real byte-level upload progress in vanilla
/// JS — `fetch()` still doesn't expose one) instead of the plain form's
/// full-page-navigating submit. Uploads run one at a time (the backend
/// route accepts a single file per POST) while tracking both a per-file bar
/// and a combined total/speed/ETA/elapsed summary. `__TOKEN__` is replaced
/// with the real share token before this is embedded in the page.
const UPLOAD_SCRIPT_TEMPLATE: &str = r#"
(function () {
    var TOKEN = "__TOKEN__";
    var fileInput = document.getElementById('fileInput');
    var uploadZone = document.getElementById('uploadZone');
    var browseLink = document.getElementById('browseLink');
    var progressCard = document.getElementById('uploadProgressCard');
    var fileListEl = document.getElementById('fileProgressList');
    var overallBar = document.getElementById('overallBar');
    var overallPercent = document.getElementById('overallPercent');
    var overallStats = document.getElementById('overallStats');
    var overallSpeed = document.getElementById('overallSpeed');
    var overallEta = document.getElementById('overallEta');
    var overallElapsed = document.getElementById('overallElapsed');

    function formatBytes(n) {
        if (!n || n <= 0) return '0 B';
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = Math.floor(Math.log(n) / Math.log(1024));
        i = Math.min(i, units.length - 1);
        return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
    }
    function formatTime(sec) {
        if (!isFinite(sec) || sec < 0) return '--';
        sec = Math.round(sec);
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        if (h > 0) return h + 'h ' + m + 'm';
        if (m > 0) return m + 'm ' + s + 's';
        return s + 's';
    }

    browseLink.addEventListener('click', function (e) { e.stopPropagation(); fileInput.click(); });
    uploadZone.addEventListener('click', function () { fileInput.click(); });
    // The dropzone is a div with role="button", so Enter/Space have to be
    // wired up by hand to match native button behaviour.
    uploadZone.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', function () {
        if (fileInput.files.length) startUpload(Array.prototype.slice.call(fileInput.files));
    });
    ['dragover', 'dragleave', 'drop'].forEach(function (evt) {
        uploadZone.addEventListener(evt, function (e) { e.preventDefault(); e.stopPropagation(); });
    });
    uploadZone.addEventListener('dragover', function () { uploadZone.classList.add('dragging'); });
    uploadZone.addEventListener('dragleave', function () { uploadZone.classList.remove('dragging'); });
    uploadZone.addEventListener('drop', function (e) {
        uploadZone.classList.remove('dragging');
        var files = e.dataTransfer && e.dataTransfer.files ? Array.prototype.slice.call(e.dataTransfer.files) : [];
        if (files.length) startUpload(files);
    });

    function startUpload(files) {
        uploadZone.style.display = 'none';
        progressCard.style.display = 'block';
        fileListEl.innerHTML = '';

        var totalBytes = files.reduce(function (sum, f) { return sum + f.size; }, 0);
        var uploadedBase = 0;
        var currentLoaded = 0;
        var startTime = Date.now();
        var lastTick = startTime;
        var lastBytes = 0;

        var rows = files.map(function (file) {
            var row = document.createElement('div');
            row.className = 'progress-row';
            row.innerHTML = '<div class="progress-row-top"><span class="progress-row-name"></span>'
                + '<span class="progress-row-state">0%</span></div>'
                + '<div class="bar slim"><div class="bar-fill"></div></div>';
            row.querySelector('.progress-row-name').textContent = file.name;
            fileListEl.appendChild(row);
            return { fill: row.querySelector('.bar-fill'), pct: row.querySelector('.progress-row-state') };
        });

        var elapsedTimer = setInterval(function () {
            overallElapsed.textContent = 'Elapsed ' + formatTime((Date.now() - startTime) / 1000);
        }, 1000);

        function updateOverall() {
            var loaded = uploadedBase + currentLoaded;
            var pct = totalBytes > 0 ? Math.min(100, (loaded / totalBytes) * 100) : 0;
            overallBar.style.width = pct + '%';
            overallPercent.textContent = Math.round(pct) + '%';
            overallStats.textContent = formatBytes(loaded) + ' / ' + formatBytes(totalBytes);
            var now = Date.now();
            var dt = (now - lastTick) / 1000;
            if (dt >= 0.4) {
                var speed = (loaded - lastBytes) / dt;
                overallSpeed.textContent = speed > 0 ? formatBytes(speed) + '/s' : '';
                var remaining = totalBytes - loaded;
                overallEta.textContent = speed > 0 ? 'ETA ' + formatTime(remaining / speed) : '';
                lastTick = now;
                lastBytes = loaded;
            }
        }

        // Posts the raw File as the request body (not a multipart form) so
        // the server gets an exact Content-Length up front and can forward
        // bytes to Telegram as they arrive instead of buffering the whole
        // file to disk first — see `upload_file_streaming`. A useful side
        // effect: because the server can only drain the body as fast as
        // Telegram accepts it, this progress bar now reflects the real
        // end-to-end rate rather than just filling the local buffer.
        //
        // Streaming means the server can't retry a failed upload (the body
        // is consumed once), so retrying is done here instead — the File is
        // still in memory, so the whole request can simply be re-sent.
        var MAX_ATTEMPTS = 3;

        function uploadOne(i, attempt) {
            if (i >= files.length) {
                clearInterval(elapsedTimer);
                overallPercent.textContent = '100%';
                overallEta.textContent = '';
                setTimeout(function () { location.reload(); }, 700);
                return;
            }
            attempt = attempt || 1;
            var file = files[i];
            currentLoaded = 0;

            function failedOrRetry(reason) {
                if (attempt < MAX_ATTEMPTS) {
                    rows[i].pct.textContent = 'Retrying ' + (attempt + 1) + '/' + MAX_ATTEMPTS;
                    rows[i].pct.className = 'progress-row-state';
                    rows[i].fill.style.width = '0%';
                    currentLoaded = 0;
                    setTimeout(function () { uploadOne(i, attempt + 1); }, 1500 * attempt);
                    return;
                }
                console.error('Upload failed for ' + file.name + ': ' + reason);
                rows[i].pct.textContent = 'Failed';
                rows[i].pct.className = 'progress-row-state fail';
                uploadOne(i + 1, 1);
            }

            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/s/' + TOKEN + '/files/stream');
            // Header values must be ASCII, so a name with non-ASCII
            // characters is percent-encoded here and decoded server-side.
            xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
            xhr.upload.addEventListener('progress', function (e) {
                if (!e.lengthComputable) return;
                currentLoaded = e.loaded;
                var filePct = (e.loaded / e.total) * 100;
                rows[i].fill.style.width = filePct + '%';
                rows[i].pct.textContent = Math.round(filePct) + '%';
                updateOverall();
            });
            xhr.addEventListener('load', function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    rows[i].fill.style.width = '100%';
                    rows[i].pct.textContent = 'Done';
                    rows[i].pct.className = 'progress-row-state ok';
                    uploadedBase += file.size;
                    currentLoaded = 0;
                    updateOverall();
                    uploadOne(i + 1, 1);
                } else {
                    failedOrRetry('HTTP ' + xhr.status + ' ' + (xhr.responseText || ''));
                }
            });
            xhr.addEventListener('error', function () {
                failedOrRetry('network error');
            });
            xhr.send(file);
        }

        uploadOne(0, 1);
    }
})();
"#;

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

/// Categorizes by extension first (more reliable than `mime_type`, which is
/// frequently just `application/octet-stream` for perfectly ordinary files)
/// falling back to the `mime_type` prefix only when the extension is
/// missing or unrecognized. Only "image"/"video" actually trigger a
/// `download_file_thumbnail` request in the caller — everything else always
/// just shows its category icon.
fn file_type_category<'a>(name: &str, mime_type: Option<&'a str>) -> &'static str {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "heic" | "heif" => "image",
        "mp4" | "mkv" | "mov" | "avi" | "webm" | "m4v" | "3gp" => "video",
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "opus" => "audio",
        "pdf" | "doc" | "docx" | "txt" | "md" | "rtf" | "odt" => "document",
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" => "archive",
        _ => match mime_type {
            Some(mime) if mime.starts_with("image/") => "image",
            Some(mime) if mime.starts_with("video/") => "video",
            Some(mime) if mime.starts_with("audio/") => "audio",
            _ => "generic",
        },
    }
}

fn file_type_icon_svg(category: &str) -> &'static str {
    match category {
        "image" => FILE_ICON_IMAGE,
        "video" => FILE_ICON_VIDEO,
        "audio" => FILE_ICON_AUDIO,
        "document" => FILE_ICON_DOCUMENT,
        "archive" => FILE_ICON_ARCHIVE,
        _ => FILE_ICON_GENERIC,
    }
}

// Minimal stroke-based icons in the same visual family (lucide-react) the
// desktop app itself uses for its own icons (see e.g. `UploadQueue.tsx`'s
// `X`/`RotateCcw`/`AlertCircle` imports) — hand-inlined as raw SVG here
// since this page is plain server-rendered HTML with no icon library.
const FILE_ICON_GENERIC: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>"#;

// Chrome icons (brand mark, buttons, empty/drop states), same stroke-based
// lucide-react family the desktop app uses for its own iconography.
const ICON_SHIELD: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>"#;
const ICON_DOWNLOAD: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>"#;
const ICON_TRASH: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>"#;
const ICON_UPLOAD: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>"#;
const ICON_FOLDER: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/></svg>"#;
const FILE_ICON_IMAGE: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>"#;
const FILE_ICON_VIDEO: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>"#;
const FILE_ICON_AUDIO: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>"#;
const FILE_ICON_DOCUMENT: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>"#;
const FILE_ICON_ARCHIVE: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>"#;

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

        if split_file::is_split_part(message.text()) {
            continue;
        }
        if let Some(manifest) = split_file::parse_manifest(message.text()) {
            entries.push(FolderShareFileEntry {
                message_id: current_id,
                name: manifest.name,
                size: manifest.size as i64,
                mime_type: Some("application/octet-stream".to_string()),
                created_at: message.date().timestamp(),
            });
            continue;
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

/// Reassembles a split file's parts (see `split_file`) into one continuous
/// HTTP response body, streamed directly from Telegram without ever
/// buffering the combined file to local disk. Supports HTTP Range requests
/// (so browsers/download managers can resume an interrupted download, and
/// video players can scrub) by mapping the requested byte range to
/// `(part_index, offset_within_part)` via `split_file::locate_offset` — the
/// same CDN-alignment technique `crate::server::build_media_response`
/// already uses for single-media Range requests, applied per-part here
/// since each part is its own independent Telegram file.
async fn download_split_file_response(
    client: &grammers_client::Client,
    peer: &Peer,
    manifest: &split_file::SplitManifest,
    req: &HttpRequest,
) -> HttpResponse {
    let messages = match split_file::fetch_messages_chunked(client, peer, &manifest.part_ids).await {
        Ok(messages) => messages,
        Err(error) => return HttpResponse::InternalServerError().body(error),
    };

    let mut medias = Vec::with_capacity(messages.len());
    for (index, message_opt) in messages.into_iter().enumerate() {
        let Some(message) = message_opt else {
            return HttpResponse::InternalServerError()
                .body(format!("Part {}/{} is missing", index + 1, manifest.part_ids.len()));
        };
        let Some(media) = message.media() else {
            return HttpResponse::InternalServerError()
                .body(format!("Part {}/{} has no data", index + 1, manifest.part_ids.len()));
        };
        medias.push(media);
    }

    let size = manifest.size;
    let mut start_byte = 0u64;
    let mut end_byte = if size > 0 { size - 1 } else { 0 };
    let mut is_range = false;
    if size > 0 {
        if let Some(range_header) = req.headers().get(actix_web::http::header::RANGE) {
            if let Ok(range_str) = range_header.to_str() {
                if let Some((start, end)) = crate::server::parse_range_header(range_str, size) {
                    start_byte = start;
                    end_byte = end;
                    is_range = true;
                }
            }
        }
    }
    let content_length = if is_range { end_byte - start_byte + 1 } else { size };

    let ranges = split_file::part_ranges(size);
    let (start_part_index, offset_in_part) = split_file::locate_offset(&ranges, start_byte);

    // Same CDN-alignment technique as `build_media_response`: Telegram may
    // round `upload.getFile`'s offset down to a 512KB boundary, so align
    // down first (relative to THIS part's own start), skip whole 64KB
    // chunks to reach that boundary, then discard the small leading slice
    // between the aligned boundary and the actually-requested byte.
    const CHUNK_SIZE: i32 = 65536;
    const CDN_ALIGNMENT: u64 = 524288;
    let cdn_aligned_offset = (offset_in_part / CDN_ALIGNMENT) * CDN_ALIGNMENT;
    let bytes_to_skip = (offset_in_part - cdn_aligned_offset) as usize;
    let start_chunk_index = (cdn_aligned_offset / CHUNK_SIZE as u64) as i32;

    let client = client.clone();
    let label = "Folder share split download";
    let stream = async_stream::stream! {
        let mut skipped: usize = 0;
        let mut total_yielded: u64 = 0;

        'parts: for (part_index, media) in medias.iter().enumerate().skip(start_part_index) {
            let mut download_iter = client.iter_download(media);
            // Only the first part we touch (the one the range start falls
            // inside) needs chunk alignment/skipping; every part after it
            // is read from its own beginning.
            if part_index == start_part_index && cdn_aligned_offset > 0 {
                download_iter = download_iter.chunk_size(CHUNK_SIZE);
                download_iter = download_iter.skip_chunks(start_chunk_index);
            }

            loop {
                match download_iter.next().await {
                    Ok(Some(data)) => {
                        let mut data_slice = data;
                        if part_index == start_part_index && skipped < bytes_to_skip {
                            let to_skip = bytes_to_skip - skipped;
                            if data_slice.len() <= to_skip {
                                skipped += data_slice.len();
                                continue;
                            } else {
                                data_slice = data_slice[to_skip..].to_vec();
                                skipped = bytes_to_skip;
                            }
                        }

                        if total_yielded + data_slice.len() as u64 > content_length {
                            let allowed = (content_length - total_yielded) as usize;
                            if allowed > 0 {
                                yield Ok::<_, actix_web::Error>(web::Bytes::from(data_slice[..allowed].to_vec()));
                                total_yielded += allowed as u64;
                            }
                            break 'parts;
                        } else {
                            let len = data_slice.len() as u64;
                            yield Ok::<_, actix_web::Error>(web::Bytes::from(data_slice));
                            total_yielded += len;
                            if total_yielded >= content_length {
                                break 'parts;
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        log::error!("{} stream error: {}", label, error);
                        return;
                    }
                }
            }
        }
        log::debug!("{} stream completed (yielded: {})", label, total_yielded);
    };

    let filename = sanitize_filename(&manifest.name);
    let mut resp = if is_range {
        let mut r = HttpResponse::PartialContent();
        r.insert_header(("Content-Range", format!("bytes {}-{}/{}", start_byte, end_byte, size)));
        r.insert_header(("Content-Length", content_length.to_string()));
        r
    } else {
        let mut r = HttpResponse::Ok();
        r.insert_header(("Content-Length", size.to_string()));
        r
    };
    resp.insert_header(("Content-Type", "application/octet-stream"));
    resp.insert_header(("Accept-Ranges", "bytes"));
    resp.insert_header((
        "Content-Disposition",
        crate::server::content_disposition_attachment(&filename),
    ));
    resp.streaming(stream)
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

    match client.get_messages_by_id(peer.clone(), &[message_id]).await {
        Ok(messages) => {
            if let Some(Some(message)) = messages.first() {
                if let Some(manifest) = split_file::parse_manifest(message.text()) {
                    return download_split_file_response(&client, &peer, &manifest, &req).await;
                }
                if let Some(media) = message.media() {
                    let mime = match &media {
                        Media::Document(document) => document.mime_type().unwrap_or("application/octet-stream").to_string(),
                        _ => "application/octet-stream".to_string(),
                    };
                    // Without a filename here `build_media_response` emits no
                    // Content-Disposition at all, so the browser renders the
                    // file inline (an image/PDF/video just opens in a tab)
                    // instead of downloading it. Name resolution follows the
                    // same convention as `list_folder_share_files`: a caption
                    // is the display name when present (that's what rename
                    // writes), otherwise the document's own name.
                    let caption = message.text();
                    let fallback_name = match &media {
                        Media::Document(document) => document.name().to_string(),
                        Media::Photo(_) => "Photo.jpg".to_string(),
                        _ => format!("file-{}", message_id),
                    };
                    let download_name = sanitize_filename(if caption.is_empty() {
                        &fallback_name
                    } else {
                        caption
                    });
                    return crate::server::build_media_response(
                        &client, &media, &req, &mime, Some(&download_name),
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

/// Streams a small embedded thumbnail (Telegram stores these directly on
/// the document/photo itself, same as `commands::preview::cmd_get_thumbnail`
/// uses for the desktop app's own file grid) so the shared-folder page can
/// show real image previews instead of a generic icon for every file.
/// Buffered fully in memory rather than streamed chunk-by-chunk — Telegram's
/// embedded thumbnails are a few KB at most, nowhere near worth the
/// complexity of a streaming response for.
#[get("/s/{token}/files/{message_id}/thumbnail")]
async fn download_file_thumbnail(
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
        return HttpResponse::NotFound().finish();
    }

    let client_opt = { tg_state.client.lock().await.clone() };
    let Some(client) = client_opt else {
        return HttpResponse::ServiceUnavailable().finish();
    };
    let peer = match resolve_peer(&client, row.folder_id, &tg_state.peer_cache).await {
        Ok(peer) => peer,
        Err(error) => {
            log::error!("Failed to resolve peer for thumbnail: {}", error);
            return HttpResponse::InternalServerError().finish();
        }
    };
    let message = match client.get_messages_by_id(peer, &[message_id]).await {
        Ok(messages) => match messages.into_iter().next().flatten() {
            Some(message) => message,
            None => return HttpResponse::NotFound().finish(),
        },
        Err(error) => {
            log::error!("Failed to fetch message for thumbnail {}: {}", message_id, error);
            return HttpResponse::InternalServerError().finish();
        }
    };
    let Some(media) = message.media() else {
        return HttpResponse::NotFound().finish();
    };
    let thumbs = match &media {
        Media::Document(document) => document.thumbs(),
        Media::Photo(photo) => photo.thumbs(),
        _ => Vec::new(),
    };
    let Some(thumbnail) = thumbs.iter().filter(|t| t.size() > 0).max_by_key(|t| t.size()) else {
        return HttpResponse::NotFound().finish();
    };

    let mut buf: Vec<u8> = Vec::with_capacity(thumbnail.size());
    let mut download_iter = client.iter_download(thumbnail);
    loop {
        match download_iter.next().await {
            Ok(Some(chunk)) => buf.extend_from_slice(&chunk),
            Ok(None) => break,
            Err(error) => {
                log::error!("Thumbnail download error for message {}: {}", message_id, error);
                return HttpResponse::InternalServerError().finish();
            }
        }
    }

    HttpResponse::Ok()
        .content_type("image/jpeg")
        .insert_header(("Cache-Control", "private, max-age=3600"))
        .body(buf)
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

async fn send_message_with_retry(
    client: &grammers_client::Client,
    peer: &Peer,
    message: InputMessage,
    net_config: &NetworkConfig,
) -> Result<i32, String> {
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
    Err(format!("Failed after {} attempts: {}", max_retries + 1, last_err))
}

/// Retries a whole upload attempt (reopening the local temp file/part fresh
/// each time), unlike `send_message_with_retry` which only ever covered the
/// follow-up message send. `upload_stream` gives grammers no resume-mid-part
/// capability (see `split_file` module docs), so a failed attempt just
/// re-uploads the same bytes from this file's own start. No shared progress
/// counter exists on this route (unlike the desktop app's), so there's no
/// double-counting to roll back — simpler than `commands::fs`'s equivalent.
async fn upload_stream_with_retry<F, Fut, T>(
    attempt: F,
    net_config: &NetworkConfig,
) -> Result<T, String>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let max_retries = net_config.retry_attempts();
    let base_ms = net_config.retry_base_backoff_ms();
    let max_ms = net_config.retry_max_backoff_ms();
    let mut last_err = String::new();

    for retry in 0..=max_retries {
        match attempt().await {
            Ok(value) => return Ok(value),
            Err(e) => {
                last_err = e;
                if retry < max_retries {
                    let wait = crate::vpn_optimizer::backoff_ms(retry, base_ms, max_ms);
                    tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
                }
            }
        }
    }
    Err(format!("Upload failed after {} attempts: {}", max_retries + 1, last_err))
}

async fn send_temp_file_to_telegram(
    client: &grammers_client::Client,
    peer: &Peer,
    net_config: &NetworkConfig,
    filename: String,
    temp_path: &std::path::Path,
    size: u64,
) -> Result<i32, String> {
    let uploaded_file = upload_stream_with_retry(
        || async {
            let mut open_file = tokio::fs::File::open(temp_path).await.map_err(|error| error.to_string())?;
            client.upload_stream(&mut open_file, size as usize, filename.clone()).await.map_err(map_error)
        },
        net_config,
    ).await?;
    let message = InputMessage::new().text("").file(uploaded_file);
    send_message_with_retry(client, peer, message, net_config).await
}

/// Seeks to `start` in `path` and returns a reader bounded to `len` bytes —
/// used to upload one part of a split file straight from the buffered temp
/// file, without loading the whole part into memory.
async fn open_ranged_file(
    path: &std::path::Path,
    start: u64,
    len: u64,
) -> Result<tokio::io::Take<tokio::io::BufReader<tokio::fs::File>>, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::open(path).await.map_err(|error| error.to_string())?;
    file.seek(std::io::SeekFrom::Start(start)).await.map_err(|error| error.to_string())?;
    Ok(tokio::io::BufReader::new(file).take(len))
}

/// Uploads a file over Telegram's per-message limit as multiple part
/// messages plus one manifest message (see `split_file`) — the same scheme
/// the desktop app's own upload path uses, adapted for this route's
/// simpler, progress-less, non-cancellable request/response shape.
async fn send_split_file_to_telegram(
    client: &grammers_client::Client,
    peer: &Peer,
    net_config: &NetworkConfig,
    filename: String,
    temp_path: &std::path::Path,
    size: u64,
) -> Result<i32, String> {
    let ranges = split_file::part_ranges(size);
    let part_count = ranges.len();
    let mut part_ids: Vec<i32> = Vec::with_capacity(part_count);

    for (index, (start, len)) in ranges.iter().enumerate() {
        let part_start = *start;
        let part_len = *len;
        let part_name = format!("part{:04}", index + 1);
        let uploaded_file = upload_stream_with_retry(
            || async {
                let mut reader = open_ranged_file(temp_path, part_start, part_len).await?;
                client.upload_stream(&mut reader, part_len as usize, part_name.clone()).await.map_err(map_error)
            },
            net_config,
        ).await?;
        let caption = split_file::part_caption(index, part_count, &filename);
        let message = InputMessage::new().text(caption).file(uploaded_file);

        match send_message_with_retry(client, peer, message, net_config).await {
            Ok(id) => part_ids.push(id),
            // Abort entirely: no manifest is sent, so this and any
            // already-sent parts stay hidden (by their own marker) but
            // orphaned — the same "duplicate/orphan over data loss"
            // tradeoff used elsewhere in this codebase.
            Err(error) => {
                return Err(format!(
                    "Split upload failed on part {}/{}: {}",
                    index + 1, part_count, error
                ));
            }
        }
    }

    let manifest = split_file::SplitManifest {
        schema_version: 1,
        name: filename,
        size,
        part_count: part_count as u32,
        part_ids,
    };
    let manifest_message = InputMessage::new().text(split_file::manifest_text(&manifest)?);
    send_message_with_retry(client, peer, manifest_message, net_config)
        .await
        .map_err(|error| format!(
            "All {} parts uploaded, but the manifest failed to send: {}", part_count, error
        ))
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

    let result = if split_file::should_split(size) {
        send_split_file_to_telegram(&client, &peer, &net_config, filename, &temp_path, size).await
    } else {
        send_temp_file_to_telegram(&client, &peer, &net_config, filename, &temp_path, size).await
    };
    let _ = tokio::fs::remove_file(&temp_path).await;

    match result {
        Ok(message_id) => HttpResponse::Ok().json(serde_json::json!({ "message_id": message_id })),
        Err(error) => {
            bw_manager.release_up(size);
            HttpResponse::InternalServerError().body(error)
        }
    }
}

/// Streams an incoming upload straight through to Telegram as its bytes
/// arrive, instead of buffering the whole file to a temp file first and only
/// then starting the Telegram upload (what `upload_file`'s multipart path
/// does). For a large file that roughly halves wall-clock time: the
/// browser→server and server→Telegram transfers overlap instead of running
/// strictly back to back.
///
/// This needs the exact byte count *before* the first byte goes to Telegram
/// (`upload_stream` derives its part count from it), which a
/// `multipart/form-data` body can't reliably supply up front — hence the
/// raw-body protocol here: the file IS the entire request body, its size is
/// `Content-Length`, and its name rides along in `X-Filename`
/// (percent-encoded, since header values must be ASCII).
///
/// Deliberate tradeoff: a request body can only be read once, so a failed
/// Telegram upload can't be retried server-side the way the temp-file path
/// retries by reopening the file. The browser still holds the `File` object,
/// so retrying is the client's job here — see `UPLOAD_SCRIPT_TEMPLATE`,
/// which re-sends the whole request on failure.
#[post("/s/{token}/files/stream")]
async fn upload_file_streaming(
    req: HttpRequest,
    path: web::Path<String>,
    payload: web::Payload,
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

    // Exact size up front — required by `upload_stream`, and it lets an
    // oversized upload be rejected before a single byte crosses the wire
    // (the multipart path can only abort partway through).
    let size = match req
        .headers()
        .get(actix_web::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(size) if size > 0 => size,
        Some(_) => return HttpResponse::BadRequest().body("File is empty"),
        None => {
            return HttpResponse::LengthRequired()
                .body("Content-Length is required for a streaming upload")
        }
    };
    if size > MAX_SHARE_UPLOAD_BYTES {
        return HttpResponse::PayloadTooLarge().body("File exceeds the maximum allowed size");
    }

    let filename = req
        .headers()
        .get("X-Filename")
        .and_then(|value| value.to_str().ok())
        .map(|raw| {
            urlencoding::decode(raw)
                .map(|decoded| decoded.into_owned())
                .unwrap_or_else(|_| raw.to_string())
        })
        .map(|name| sanitize_filename(&name))
        .unwrap_or_else(|| "file".to_string());

    let client_opt = { tg_state.client.lock().await.clone() };
    let Some(client) = client_opt else {
        return HttpResponse::ServiceUnavailable().body("Telegram client is not connected");
    };

    if let Err(error) = bw_manager.try_reserve_up(size) {
        return HttpResponse::BadRequest().body(error);
    }
    let peer = match resolve_peer(&client, row.folder_id, &tg_state.peer_cache).await {
        Ok(peer) => peer,
        Err(error) => {
            bw_manager.release_up(size);
            return HttpResponse::InternalServerError().body(error);
        }
    };

    // Bridge actix's body stream into an `AsyncRead` grammers can consume
    // directly, so nothing is ever staged on local disk.
    let byte_stream =
        payload.map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error));
    let mut reader = tokio_util::io::StreamReader::new(byte_stream);

    let result = if split_file::should_split(size) {
        stream_split_file_to_telegram(&client, &peer, &net_config, filename, &mut reader, size).await
    } else {
        stream_single_file_to_telegram(&client, &peer, &net_config, filename, &mut reader, size).await
    };

    match result {
        Ok(message_id) => HttpResponse::Ok().json(serde_json::json!({ "message_id": message_id })),
        Err(error) => {
            bw_manager.release_up(size);
            HttpResponse::InternalServerError().body(error)
        }
    }
}

async fn stream_single_file_to_telegram<R>(
    client: &grammers_client::Client,
    peer: &Peer,
    net_config: &NetworkConfig,
    filename: String,
    reader: &mut R,
    size: u64,
) -> Result<i32, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let uploaded_file = client
        .upload_stream(reader, size as usize, filename)
        .await
        .map_err(map_error)?;
    let message = InputMessage::new().text("").file(uploaded_file);
    send_message_with_retry(client, peer, message, net_config).await
}

/// Splits a streamed upload across multiple part messages (see `split_file`)
/// by taking each part's byte count off the front of the same body stream in
/// order. No seeking is involved — which is what makes this work at all on a
/// network stream — and `part_ranges` already yields its ranges front-to-back.
async fn stream_split_file_to_telegram<R>(
    client: &grammers_client::Client,
    peer: &Peer,
    net_config: &NetworkConfig,
    filename: String,
    reader: &mut R,
    size: u64,
) -> Result<i32, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    let ranges = split_file::part_ranges(size);
    let part_count = ranges.len();
    let mut part_ids: Vec<i32> = Vec::with_capacity(part_count);

    for (index, (_, len)) in ranges.iter().enumerate() {
        let mut part = (&mut *reader).take(*len);
        let uploaded_file = client
            .upload_stream(&mut part, *len as usize, format!("part{:04}", index + 1))
            .await
            .map_err(map_error)?;
        let caption = split_file::part_caption(index, part_count, &filename);
        let message = InputMessage::new().text(caption).file(uploaded_file);
        match send_message_with_retry(client, peer, message, net_config).await {
            Ok(id) => part_ids.push(id),
            // Abort without sending a manifest: already-sent parts stay
            // hidden behind their own marker but orphaned — the same accepted
            // "duplicate/orphan over data loss" tradeoff used elsewhere.
            Err(error) => {
                return Err(format!(
                    "Split upload failed on part {}/{}: {}",
                    index + 1,
                    part_count,
                    error
                ))
            }
        }
    }

    let manifest = split_file::SplitManifest {
        schema_version: 1,
        name: filename,
        size,
        part_count: part_count as u32,
        part_ids,
    };
    let manifest_text = split_file::manifest_text(&manifest)?;
    send_message_with_retry(client, peer, InputMessage::new().text(manifest_text), net_config)
        .await
        .map_err(|error| {
            format!(
                "All {} parts uploaded, but the manifest failed to send: {}",
                part_count, error
            )
        })
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
    // Also captures whether the old file was itself a split file, so its
    // full part group (not just the manifest id) gets cleaned up below.
    let old_manifest = match client.get_messages_by_id(peer.clone(), &[old_message_id]).await {
        Ok(messages) => match messages.into_iter().next().flatten() {
            Some(message) => split_file::parse_manifest(message.text()),
            None => return HttpResponse::NotFound().body("File not found in this shared folder"),
        },
        Err(_) => return HttpResponse::NotFound().body("File not found in this shared folder"),
    };

    let (filename, temp_path, size) = match receive_upload(payload).await {
        Ok(result) => result,
        Err(response) => return response,
    };
    if let Err(error) = bw_manager.try_reserve_up(size) {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return HttpResponse::BadRequest().body(error);
    }

    let result = if split_file::should_split(size) {
        send_split_file_to_telegram(&client, &peer, &net_config, filename, &temp_path, size).await
    } else {
        send_temp_file_to_telegram(&client, &peer, &net_config, filename, &temp_path, size).await
    };
    let _ = tokio::fs::remove_file(&temp_path).await;

    let new_message_id = match result {
        Ok(id) => id,
        Err(error) => {
            bw_manager.release_up(size);
            return HttpResponse::InternalServerError().body(error);
        }
    };

    let mut ids_to_delete = vec![old_message_id];
    if let Some(manifest) = old_manifest {
        ids_to_delete = manifest.part_ids;
        ids_to_delete.push(old_message_id);
    }
    for batch in ids_to_delete.chunks(100) {
        if let Err(error) = client.delete_messages(&peer, batch).await {
            log::warn!(
                "Folder share update: uploaded replacement {} but failed to delete old message(s) for {}: {}",
                new_message_id, old_message_id, error
            );
        }
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

    let ids_to_delete = match client.get_messages_by_id(peer.clone(), &[message_id]).await {
        Ok(messages) => match messages.into_iter().next().flatten() {
            Some(message) => match split_file::parse_manifest(message.text()) {
                Some(manifest) => {
                    let mut ids = manifest.part_ids;
                    ids.push(message_id);
                    ids
                }
                None => vec![message_id],
            },
            None => vec![message_id],
        },
        Err(_) => vec![message_id],
    };

    for batch in ids_to_delete.chunks(100) {
        if let Err(error) = client.delete_messages(&peer, batch).await {
            return HttpResponse::InternalServerError().body(error.to_string());
        }
    }
    HttpResponse::Ok().finish()
}

pub fn configure_folder_share_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(folder_share_page)
        .service(verify_folder_share_password)
        .service(list_files_json)
        .service(download_file)
        .service(download_file_thumbnail)
        .service(upload_file_streaming)
        .service(upload_file)
        .service(update_file)
        .service(delete_file);
}

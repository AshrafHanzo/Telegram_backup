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
                r#"<a class="btn ghost" href="/s/{token}/files/{id}">Download</a>"#,
                token = token, id = entry.message_id
            );
            if row.permissions.contains(SharePermissions::DELETE) {
                actions.push_str(&format!(
                    r#" <button class="btn danger" onclick="del({})">Delete</button>"#,
                    entry.message_id
                ));
            }

            format!(
                r#"<div class="file-card"><div class="file-thumb">{thumb}</div><div class="file-info"><div class="file-name" title="{name}"><bdi dir="auto">{name}</bdi></div><div class="file-size">{size}</div></div><div class="file-actions">{actions}</div></div>"#,
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
        r##"<div id="uploadZone" class="upload-zone">
            <input type="file" id="fileInput" multiple hidden>
            <div class="upload-icon">&#8679;</div>
            <p>Drag and drop files here, or <a href="#" id="browseLink">choose files</a> to upload</p>
        </div>
        <div id="uploadProgressCard" class="card upload-progress-card" style="display:none;">
            <div class="upload-progress-header">
                <div class="progress-summary-row">
                    <strong id="overallPercent">0%</strong>
                    <span id="overallStats">0 B / 0 B</span>
                </div>
                <div class="progress-bar-track"><div class="progress-bar-fill" id="overallBar"></div></div>
                <div class="progress-meta-row">
                    <span id="overallSpeed"></span>
                    <span id="overallEta"></span>
                    <span id="overallElapsed"></span>
                </div>
            </div>
            <div class="file-progress-list" id="fileProgressList"></div>
        </div>"##.to_string()
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
    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{name} - Shared Folder - Telegram Drive</title>
    <style>{style}</style>
</head>
<body>
    <div class="wrap">
        <h1>Shared folder: <bdi dir="auto">{name}</bdi></h1>
        {listing}
        {upload}
    </div>
    {script}
</body>
</html>"#,
        name = safe_folder_name,
        style = SHARE_PAGE_CSS,
        listing = if entries.is_empty() {
            r#"<div class="card"><div class="empty">No files to show.</div></div>"#.to_string()
        } else {
            format!(r#"<div class="file-grid">{}</div>"#, cards_html)
        },
        upload = upload_html,
        script = script,
    );
    HttpResponse::Ok().content_type("text/html; charset=utf-8").body(html)
}

/// The desktop app's actual default-theme palette (`Default Dark` in
/// `src/theme/presets.ts`) — matched exactly so this server-rendered page
/// looks like part of the same app instead of a generic fallback page.
const SHARE_PAGE_CSS: &str = r#"
    :root {
        --bg: #101114; --surface: #1b1c20; --primary: #2aabee; --secondary: #63a9ff;
        --text: #f7f7f5; --subtext: #b2b3ba; --border: rgba(255,255,255,0.1); --hover: rgba(255,255,255,0.055);
    }
    * { box-sizing: border-box; }
    body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; margin:0; padding:2rem 1.25rem; }
    .wrap { max-width:640px; margin:0 auto; }
    h1 { font-size:1.15rem; font-weight:600; margin:0 0 1.25rem; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:0.75rem; overflow:hidden; margin-bottom:1rem; }
    .file-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:0.85rem; margin-bottom:1rem; }
    .file-card { background:var(--surface); border:1px solid var(--border); border-radius:0.75rem; overflow:hidden; display:flex; flex-direction:column; }
    .file-thumb { position:relative; aspect-ratio:1.6/1; background:var(--hover); }
    .file-thumb .file-icon { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--subtext); }
    .file-thumb .file-icon svg { width:2rem; height:2rem; }
    .file-thumb img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
    .file-info { padding:0.6rem 0.7rem 0.25rem; min-width:0; }
    .file-name { font-size:0.82rem; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .file-size { font-size:0.74rem; color:var(--subtext); margin-top:0.15rem; }
    .file-actions { display:flex; gap:0.4rem; padding:0.55rem 0.7rem 0.7rem; }
    .file-actions .btn { flex:1; justify-content:center; padding:0.35rem 0.5rem; font-size:0.76rem; }
    .btn { display:inline-flex; align-items:center; gap:0.35rem; padding:0.4rem 0.85rem; border-radius:0.5rem; background:var(--primary); color:#fff; text-decoration:none; border:none; cursor:pointer; font-size:0.82rem; font-weight:500; }
    .btn:hover { filter:brightness(1.08); }
    .btn.danger { background:#e05c5c; }
    .btn.ghost { background:transparent; border:1px solid var(--border); color:var(--subtext); }
    .btn.ghost:hover { color:var(--text); border-color:var(--subtext); }
    .empty { color:var(--subtext); padding:2rem 1rem; text-align:center; font-size:0.9rem; }
    .upload-zone { border:2px dashed var(--border); border-radius:0.75rem; padding:1.75rem 1.25rem; text-align:center; transition:border-color .15s, background .15s; cursor:pointer; }
    .upload-zone.dragging { border-color:var(--primary); background:rgba(42,171,238,0.08); }
    .upload-icon { font-size:1.6rem; margin-bottom:0.5rem; opacity:.85; }
    .upload-zone p { margin:0; color:var(--subtext); font-size:0.88rem; }
    .upload-zone a { color:var(--primary); text-decoration:none; font-weight:500; }
    .upload-progress-card { margin-top:1rem; }
    .upload-progress-header { padding:0.85rem 1rem; border-bottom:1px solid var(--border); background:var(--hover); }
    .progress-summary-row { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:0.5rem; font-size:0.82rem; color:var(--subtext); }
    .progress-summary-row strong { color:var(--text); font-size:0.95rem; }
    .progress-meta-row { display:flex; gap:0.9rem; font-size:0.74rem; color:var(--subtext); margin-top:0.4rem; }
    .progress-bar-track { width:100%; background:var(--border); height:6px; border-radius:999px; overflow:hidden; }
    .progress-bar-track.small { height:4px; margin:0.3rem 0 0; }
    .progress-bar-fill { height:100%; background:var(--primary); border-radius:999px; width:0%; transition:width .2s linear; }
    .file-progress-list { max-height:220px; overflow-y:auto; padding:0.4rem; }
    .file-progress-row { padding:0.55rem 0.6rem; border-radius:0.5rem; }
    .file-progress-row:hover { background:var(--hover); }
    .file-progress-top { display:flex; justify-content:space-between; gap:0.5rem; font-size:0.8rem; }
    .file-progress-name { color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
    .file-progress-pct { color:var(--subtext); flex-shrink:0; }
    .file-progress-pct.ok { color:#4ade80; }
    .file-progress-pct.fail { color:#e05c5c; }
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

    browseLink.addEventListener('click', function (e) { e.preventDefault(); fileInput.click(); });
    uploadZone.addEventListener('click', function (e) { if (e.target !== browseLink) fileInput.click(); });
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
            row.className = 'file-progress-row';
            row.innerHTML = '<div class="file-progress-top"><span class="file-progress-name"></span>'
                + '<span class="file-progress-pct">0%</span></div>'
                + '<div class="progress-bar-track small"><div class="progress-bar-fill"></div></div>';
            row.querySelector('.file-progress-name').textContent = file.name;
            fileListEl.appendChild(row);
            return { fill: row.querySelector('.progress-bar-fill'), pct: row.querySelector('.file-progress-pct') };
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

        function uploadOne(i) {
            if (i >= files.length) {
                clearInterval(elapsedTimer);
                overallPercent.textContent = '100%';
                overallEta.textContent = '';
                setTimeout(function () { location.reload(); }, 700);
                return;
            }
            var file = files[i];
            currentLoaded = 0;
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/s/' + TOKEN + '/files');
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
                    rows[i].pct.className = 'file-progress-pct ok';
                    uploadedBase += file.size;
                    currentLoaded = 0;
                    updateOverall();
                } else {
                    rows[i].pct.textContent = 'Failed';
                    rows[i].pct.className = 'file-progress-pct fail';
                }
                uploadOne(i + 1);
            });
            xhr.addEventListener('error', function () {
                rows[i].pct.textContent = 'Failed';
                rows[i].pct.className = 'file-progress-pct fail';
                uploadOne(i + 1);
            });
            var formData = new FormData();
            formData.append('file', file);
            xhr.send(formData);
        }

        uploadOne(0);
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
        format!("attachment; filename=\"{}\"", filename),
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
        .service(upload_file)
        .service(update_file)
        .service(delete_file);
}

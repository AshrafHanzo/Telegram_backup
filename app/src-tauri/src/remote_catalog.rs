//! Lets the mobile app remotely browse and manage this desktop's Backup
//! feature through Telegram, with no direct connection between the two
//! devices — everything travels as one of two marked JSON messages in the
//! user's own Saved Messages (same mechanism as `audit_sync.rs`):
//!
//! - `[TD-CATALOG]`: a metadata-only snapshot of every enabled backup
//!   source's files (path/size/mtime + a small cover image for photos) —
//!   never the file contents themselves. Mobile can browse this at any
//!   time, even while this desktop is completely offline.
//! - `[TD-REMOTE-JOBS]`: a small job queue. Mobile appends a job
//!   (`add_source`/`remove_source`) with `status: "pending"`; this desktop
//!   checks the queue exactly once per launch (right after Telegram
//!   connects, never on a timer/poll loop), performs any pending job by
//!   calling the exact same functions the desktop UI itself calls, and
//!   flips its status to `"completed"`/`"failed"` before pushing the queue
//!   back. Every processed job is also written to the audit log.

use crate::commands::backup::{
    cmd_add_backup_source, cmd_remove_backup_source, load_settings, BackupState,
};
use crate::commands::notifications::push_audit_log;
use crate::commands::utils::resolve_peer;
use crate::db::DbConnection;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use grammers_client::types::{Media, Peer};
use grammers_client::{Client, InputMessage};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;

type PeerCache = Arc<RwLock<HashMap<i64, Peer>>>;

pub(crate) const CATALOG_MARKER: &str = "[TD-CATALOG]";
pub(crate) const JOBS_MARKER: &str = "[TD-REMOTE-JOBS]";
/// Desktop → mobile: the live folder-share list plus the current public base
/// URL. Written only by desktop (mobile requests changes through the job
/// queue), so unlike the jobs blob this one has a single writer.
pub(crate) const SHARES_MARKER: &str = "[TD-SHARES]";
const SCAN_LIMIT: usize = 300;
/// How long a completed/failed job stays in the shared blob before being
/// pruned. Long enough that mobile (which only re-reads on screen open or
/// pull-to-refresh) reliably sees the outcome of what it submitted.
const SETTLED_JOB_RETENTION_SECS: i64 = 7 * 24 * 60 * 60;
const MAX_ENTRIES_PER_SOURCE: usize = 2000;
const COVER_MAX_DIMENSION: u32 = 48;
const COVER_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];

// ---------------------------------------------------------------------------
// Catalog types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CatalogEntry {
    pub relative_path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified_at: Option<i64>,
    /// Small JPEG, base64-encoded — images only for now. Video covers would
    /// need this app's separate ffmpeg-based frame extraction path; left out
    /// of this pass to keep it low-risk, so videos just get no cover here.
    pub cover_base64: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SourceCatalog {
    pub source_id: String,
    pub display_name: String,
    pub entries: Vec<CatalogEntry>,
    pub truncated: bool,
    pub synced_at: i64,
}

// ---------------------------------------------------------------------------
// Job queue types
// ---------------------------------------------------------------------------

// Deliberately NOT `#[serde(flatten)]`d into RemoteJob below — combining
// flatten with an internally-tagged enum is a known serde edge case that
// can't be verified without compiling, so this stays a plain nested field
// instead. Both ends of this JSON (desktop and mobile) are code I control,
// so there's no external format to match — the extra nesting costs nothing.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RemoteJobAction {
    AddSource { path: String, display_name: Option<String> },
    RemoveSource { source_id: String },
    /// Duplicate a file/folder into another (possibly different) source's
    /// folder, keeping its original name. `dest_folder_path` is a path
    /// relative to `dest_source_id`'s root, `""` meaning that source's root.
    CopyEntry {
        source_id: String,
        relative_path: String,
        dest_source_id: String,
        dest_folder_path: String,
    },
    /// Same as `CopyEntry` but removes the original afterwards — mobile's
    /// "cut, then paste".
    MoveEntry {
        source_id: String,
        relative_path: String,
        dest_source_id: String,
        dest_folder_path: String,
    },
    /// Mobile asking desktop to create a real "Temp Link" folder share.
    /// Mobile can't serve a link itself (no HTTP server, no tunnel, and the
    /// OS suspends background apps), and desktop resolves share tokens only
    /// from its own SQLite — so the share has to be created here.
    ///
    /// `share_id` is minted by MOBILE, not desktop. That's what makes this
    /// job idempotent: the jobs blob is whole-file last-write-wins with no
    /// locking (see `save_jobs`' note below), so a stale mobile write can
    /// re-present an already-completed job as pending. Keying on a
    /// caller-supplied token means a re-run is a no-op instead of minting a
    /// second live share for the same request.
    ///
    /// `password_hash` is already bcrypt-hashed by the phone — plaintext
    /// must never enter this blob, which lives indefinitely in Saved
    /// Messages. `expires_at` is absolute rather than a duration so a PC
    /// that was offline for days doesn't silently extend the window.
    CreateFolderShare {
        share_id: String,
        /// Raw channel id (`Peer::Channel(c) => c.raw.id`), NOT a TDLib
        /// `-100…` chat id — mobile must send `supergroupId`. `None` means
        /// Saved Messages, matching `resolve_peer`.
        folder_id: Option<i64>,
        folder_name: String,
        can_upload: bool,
        can_download: bool,
        can_update: bool,
        can_delete: bool,
        #[serde(default)]
        username: Option<String>,
        #[serde(default)]
        password_hash: Option<String>,
        #[serde(default)]
        expires_at: Option<i64>,
    },
    /// Revoking is already idempotent (a plain `UPDATE … SET revoked = 1`),
    /// so it needs no extra guard.
    RevokeFolderShare { share_id: String },
}

/// What desktop publishes for mobile under `SHARES_MARKER`. Deliberately
/// carries the live tunnel base URL rather than pre-built links, because the
/// host changes underneath us (see `publish_shares_to_telegram`).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SharePublication {
    /// False when no public tunnel is up — `base_url` is then loopback and
    /// unusable from another device.
    pub public: bool,
    pub base_url: String,
    pub updated_at: i64,
    pub shares: Vec<PublishedShare>,
}

/// One share as mobile sees it. Carries the raw `permissions` bitfield
/// (bit-compatible with `SharePermissions`) rather than four booleans so it
/// matches what mobile already mirrors in `SharePermissionBits`. No password
/// material is ever published — only whether one is set.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PublishedShare {
    pub id: String,
    pub folder_id: Option<i64>,
    pub folder_name: String,
    pub permissions: i64,
    pub has_password: bool,
    pub username: Option<String>,
    pub expires_at: Option<i64>,
    pub created_at: i64,
}

/// A share token becomes a public URL path segment and a database primary
/// key, so a mobile-supplied one is validated rather than trusted: exactly
/// the 32 lowercase hex characters `generate_share_token` produces.
fn validate_share_token(token: &str) -> Result<(), String> {
    let well_formed = token.len() == 32
        && token
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character));
    if well_formed {
        Ok(())
    } else {
        Err("Share id must be 32 lowercase hexadecimal characters".to_string())
    }
}

/// The phone hashes share passwords itself (plaintext must never enter the
/// jobs blob, which lives indefinitely in Saved Messages), so the hash
/// arrives pre-computed and is fed straight to `verify_password` later. The
/// cost is capped because verification time is exponential in it — an
/// absurd cost would turn every link visit into a CPU stall.
fn validate_bcrypt_hash(hash: &str) -> Result<(), String> {
    let rest = hash
        .strip_prefix("$2a$")
        .or_else(|| hash.strip_prefix("$2b$"))
        .or_else(|| hash.strip_prefix("$2y$"))
        .ok_or_else(|| "Password hash is not a bcrypt hash".to_string())?;
    let (cost, remainder) = rest
        .split_once('$')
        .ok_or_else(|| "Malformed bcrypt hash: missing cost separator".to_string())?;
    let cost: u32 = cost
        .parse()
        .map_err(|_| "Malformed bcrypt hash: unreadable cost".to_string())?;
    if !(4..=14).contains(&cost) {
        return Err(format!("Unsupported bcrypt cost {} (expected 4-14)", cost));
    }
    if remainder.len() < 53 {
        return Err("Malformed bcrypt hash: truncated".to_string());
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteJobStatus {
    Pending,
    Completed,
    Failed,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RemoteJob {
    pub id: String,
    pub action: RemoteJobAction,
    pub status: RemoteJobStatus,
    pub error: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// Saved-Messages marker-message helpers (mirrors audit_sync.rs exactly)
// ---------------------------------------------------------------------------

async fn find_marker_message(
    client: &Client,
    peer: &Peer,
    marker: &str,
) -> Result<Option<grammers_client::types::Message>, String> {
    let mut iter = client.iter_messages(peer);
    let mut scanned = 0usize;
    while scanned < SCAN_LIMIT {
        let Some(msg) = iter.next().await.map_err(|e| e.to_string())? else {
            break;
        };
        scanned += 1;
        if msg.text() == marker && msg.media().is_some() {
            return Ok(Some(msg));
        }
    }
    Ok(None)
}

async fn download_media_bytes(client: &Client, media: &Media) -> Result<Vec<u8>, String> {
    let mut download = client.iter_download(media);
    let mut bytes = Vec::new();
    while let Some(chunk) = download.next().await.map_err(|e| e.to_string())? {
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn publish_json(
    app: &AppHandle,
    client: &Client,
    peer: &Peer,
    marker: &str,
    file_name: &str,
    json_bytes: &[u8],
) -> Result<(), String> {
    // Find the existing marker (if any) but don't delete it yet — upload and
    // send the new one FIRST, so a failed upload/send never leaves the
    // marker missing entirely. `find_marker_message` prefers the newest
    // match (iter_messages scans newest-first), so briefly having both old
    // and new marker messages alive is harmless; only delete the old one
    // once the new one is confirmed sent.
    let existing = find_marker_message(client, peer, marker).await?;

    let temp_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let temp_path = temp_dir.join(format!("{}.tmp", file_name));
    tokio::fs::write(&temp_path, json_bytes).await.map_err(|e| e.to_string())?;

    let mut file = tokio::fs::File::open(&temp_path).await.map_err(|e| e.to_string())?;
    let uploaded = client
        .upload_stream(&mut file, json_bytes.len(), file_name.to_string())
        .await
        .map_err(|e| e.to_string());
    let _ = tokio::fs::remove_file(&temp_path).await;
    let uploaded = uploaded?;

    let message = InputMessage::new().text(marker).file(uploaded);
    client.send_message(peer, message).await.map_err(|e| e.to_string())?;

    if let Some(existing) = existing {
        let _ = client.delete_messages(peer, &[existing.id()]).await;
    }
    Ok(())
}

async fn load_json_from_marker<T: for<'de> Deserialize<'de> + Default>(
    client: &Client,
    peer: &Peer,
    marker: &str,
) -> Result<T, String> {
    let Some(message) = find_marker_message(client, peer, marker).await? else {
        return Ok(T::default());
    };
    let Some(media) = message.media() else {
        return Ok(T::default());
    };
    let bytes = download_media_bytes(client, &media).await?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Cover generation — small JPEG, images only. Best-effort: any failure
// (unreadable, unsupported format, corrupt file) just means no cover, never
// a hard error that would abort the whole catalog sync.
// ---------------------------------------------------------------------------

fn generate_cover(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if !COVER_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }

    let reader = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let decoded = reader.decode().ok()?;
    let resized = decoded.thumbnail(COVER_MAX_DIMENSION, COVER_MAX_DIMENSION);
    let rgba = resized.to_rgba8();
    let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
    for (source, destination) in rgba.pixels().zip(rgb.pixels_mut()) {
        let alpha = source[3] as u16;
        let inverse_alpha = 255 - alpha;
        *destination = image::Rgb([
            ((source[0] as u16 * alpha + 248 * inverse_alpha) / 255) as u8,
            ((source[1] as u16 * alpha + 248 * inverse_alpha) / 255) as u8,
            ((source[2] as u16 * alpha + 248 * inverse_alpha) / 255) as u8,
        ]);
    }

    let mut buffer = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 60);
    encoder.encode_image(&image::DynamicImage::ImageRgb8(rgb)).ok()?;
    Some(STANDARD.encode(&buffer))
}

fn build_catalog_for_source(source: &crate::commands::backup::BackupSourceFolder) -> SourceCatalog {
    let root = Path::new(&source.local_path);
    let excluded: Vec<String> = source
        .excluded_paths
        .iter()
        .map(|p| p.replace('\\', "/").trim_matches('/').to_string())
        .filter(|p| !p.is_empty())
        .collect();

    let mut entries = Vec::new();
    let mut truncated = false;

    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| {
            if excluded.is_empty() || entry.path() == root {
                return true;
            }
            let Ok(relative) = entry.path().strip_prefix(root) else { return true };
            let relative_str = relative.to_string_lossy().replace('\\', "/");
            !excluded
                .iter()
                .any(|excluded_path| {
                    relative_str == *excluded_path
                        || relative_str.starts_with(&format!("{}/", excluded_path))
                })
        })
        .filter_map(|entry| entry.ok())
    {
        if entry.path() == root {
            continue;
        }
        if entries.len() >= MAX_ENTRIES_PER_SOURCE {
            truncated = true;
            break;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else { continue };
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        let is_dir = entry.file_type().is_dir();
        let metadata = entry.metadata().ok();
        let size = if is_dir { None } else { metadata.as_ref().map(|m| m.len()) };
        let modified_at = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        let cover_base64 = if is_dir { None } else { generate_cover(entry.path()) };

        entries.push(CatalogEntry { relative_path, is_dir, size, modified_at, cover_base64 });
    }

    SourceCatalog {
        source_id: source.id.clone(),
        display_name: source.display_name.clone(),
        entries,
        truncated,
        synced_at: chrono::Utc::now().timestamp(),
    }
}

// ---------------------------------------------------------------------------
// Copy/move execution — mobile's "cut/copy, then paste". Runs synchronously
// (std::fs, same as build_catalog_for_source's walk above) inside the
// spawned one-shot job-processing task, so blocking briefly here doesn't
// touch the UI thread; personal backup folders are small enough that this
// is not a real performance concern.
// ---------------------------------------------------------------------------

/// Joins `relative_path` onto `root`, rejecting `..`, empty/`.` segments,
/// and any segment containing `:` (a bare drive letter smuggled in via a
/// backslash-joined string with no `/` at all, e.g. `"..\\..\\D:\\secret"`,
/// which a naive "reject the literal string `..`" check would miss
/// entirely). Job payloads come from the mobile app over Telegram, not from
/// this process, so a path is never trusted blindly before it's joined onto
/// a real filesystem root — mirrors `commands::backup::sanitize_restore_path`,
/// which solves the identical problem for restored file names.
///
/// `allow_empty_as_root`: `dest_folder_path` legitimately uses `""` to mean
/// "the destination source's root folder itself"; `relative_path` (the
/// thing being copied/moved) never should, since "the root itself" isn't a
/// single named entry that can be copied/moved.
fn safe_join(root: &Path, relative_path: &str, allow_empty_as_root: bool) -> Option<PathBuf> {
    let mut target = root.to_path_buf();
    let mut had_component = false;
    for part in relative_path.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        if part.contains(':') {
            return None;
        }
        target.push(part);
        had_component = true;
    }
    if !had_component {
        return if allow_empty_as_root { Some(root.to_path_buf()) } else { None };
    }
    Some(target)
}

/// Defense in depth: even after `safe_join`'s sanitization, confirm the path
/// actually resolves inside `root` once the filesystem has normalized it
/// (symlinks, junctions, etc.) — same rationale as the canonicalize-based
/// check `restore_one_file` runs in `commands::backup`. Both `path` and
/// `root` must already exist.
fn confirm_contained(root: &Path, path: &Path) -> Result<(), String> {
    let canonical_root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let canonical_path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if canonical_path.starts_with(&canonical_root) {
        Ok(())
    } else {
        Err("Resolved path escapes the registered backup folder".to_string())
    }
}

fn copy_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for entry in walkdir::WalkDir::new(src).min_depth(1) {
            let entry = entry.map_err(|e| e.to_string())?;
            let relative = entry.path().strip_prefix(src).map_err(|e| e.to_string())?;
            let target = dest.join(relative);
            if entry.file_type().is_dir() {
                std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    } else {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(src, dest).map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn remove_recursive(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }
}

fn copy_or_move_entry(
    app: &AppHandle,
    source_id: &str,
    relative_path: &str,
    dest_source_id: &str,
    dest_folder_path: &str,
    is_move: bool,
) -> Result<(), String> {
    let settings = load_settings(app);
    let source = settings
        .sources
        .iter()
        .find(|s| s.id == source_id)
        .ok_or_else(|| format!("Source \"{}\" not found", source_id))?;
    let dest_source = settings
        .sources
        .iter()
        .find(|s| s.id == dest_source_id)
        .ok_or_else(|| format!("Destination source \"{}\" not found", dest_source_id))?;

    let src_path = safe_join(Path::new(&source.local_path), relative_path, false)
        .ok_or_else(|| "Invalid source path".to_string())?;
    if !src_path.exists() {
        return Err(format!("\"{}\" no longer exists", relative_path));
    }
    confirm_contained(Path::new(&source.local_path), &src_path)?;

    let dest_dir = safe_join(Path::new(&dest_source.local_path), dest_folder_path, true)
        .ok_or_else(|| "Invalid destination path".to_string())?;
    if !dest_dir.is_dir() {
        return Err(format!("Destination folder \"{}\" no longer exists", dest_folder_path));
    }
    confirm_contained(Path::new(&dest_source.local_path), &dest_dir)?;

    let file_name = src_path
        .file_name()
        .ok_or_else(|| "Invalid source path".to_string())?;
    let dest_path = dest_dir.join(file_name);

    if dest_path == src_path {
        return Err("Source and destination are the same".to_string());
    }
    if dest_path.exists() {
        return Err(format!(
            "\"{}\" already exists in the destination",
            file_name.to_string_lossy()
        ));
    }
    if src_path.is_dir() && dest_path.starts_with(&src_path) {
        return Err("Cannot move or copy a folder into itself".to_string());
    }

    if is_move {
        if std::fs::rename(&src_path, &dest_path).is_ok() {
            return Ok(());
        }
        // Cross-device (e.g. different drive) rename fails — fall back to
        // copy-then-remove-original.
        copy_recursive(&src_path, &dest_path)?;
        remove_recursive(&src_path)?;
        Ok(())
    } else {
        copy_recursive(&src_path, &dest_path)
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Rebuilds and republishes the catalog for every enabled backup source.
/// Best-effort by design — a failed sync never blocks whatever triggered it.
pub async fn sync_catalog_to_telegram(
    app: &AppHandle,
    client: &Client,
    peer_cache: &PeerCache,
) -> Result<(), String> {
    let settings = load_settings(app);
    let catalogs: Vec<SourceCatalog> = settings
        .sources
        .iter()
        .filter(|source| source.enabled)
        .map(build_catalog_for_source)
        .collect();

    let json_bytes = serde_json::to_vec(&catalogs).map_err(|e| e.to_string())?;
    let peer = resolve_peer(client, None, peer_cache).await?;
    publish_json(app, client, &peer, CATALOG_MARKER, "backup-catalog.json", &json_bytes).await
}

/// Publishes the desktop's current folder shares for mobile to read.
///
/// Mobile can't derive a link itself: the Cloudflare quick-tunnel host is
/// random and changes not only on every desktop restart but mid-session too
/// (`tunnel.rs` clears it when cloudflared exits and gets a fresh one on
/// respawn). So this carries the live `base_url` alongside each share's
/// stable token, and mobile composes `base_url + /s/ + token` at display
/// time — the same "token is identity, URL is derived" rule
/// `cmd_list_folder_shares` follows.
///
/// `public` is false when no tunnel is up, in which case `base_url` is the
/// loopback fallback and is useless to a phone — mobile shows a "waiting for
/// your PC's public link" state rather than a link that cannot work.
pub async fn publish_shares_to_telegram(
    app: &AppHandle,
    client: &Client,
    peer_cache: &PeerCache,
) -> Result<(), String> {
    let tunnel_base = app
        .try_state::<std::sync::Arc<crate::tunnel::TunnelState>>()
        .and_then(|state| state.base_url());
    let publication = SharePublication {
        public: tunnel_base.is_some(),
        base_url: tunnel_base
            .unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::STREAM_PORT)),
        updated_at: chrono::Utc::now().timestamp(),
        shares: load_shares_for_publication(&app.state::<DbConnection>())?,
    };

    let json_bytes = serde_json::to_vec(&publication).map_err(|e| e.to_string())?;
    let peer = resolve_peer(client, None, peer_cache).await?;
    publish_json(app, client, &peer, SHARES_MARKER, "folder-shares.json", &json_bytes).await
}

/// Reads every live share straight from the same table the HTTP routes
/// serve from, so mobile can never show a link desktop wouldn't honour.
fn load_shares_for_publication(db_pool: &DbConnection) -> Result<Vec<PublishedShare>, String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, folder_id, folder_name, permissions, password_hash, username, expires_at, created_at
             FROM folder_shares WHERE revoked = 0 ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let mut shares = Vec::new();
    while let sqlite::State::Row = stmt.next().map_err(|e| e.to_string())? {
        shares.push(PublishedShare {
            id: stmt.read::<String, _>("id").map_err(|e| e.to_string())?,
            folder_id: stmt.read::<Option<i64>, _>("folder_id").ok().flatten(),
            folder_name: stmt.read::<String, _>("folder_name").map_err(|e| e.to_string())?,
            permissions: stmt.read::<i64, _>("permissions").map_err(|e| e.to_string())?,
            has_password: stmt
                .read::<Option<String>, _>("password_hash")
                .ok()
                .flatten()
                .is_some(),
            username: stmt.read::<Option<String>, _>("username").ok().flatten(),
            expires_at: stmt.read::<Option<i64>, _>("expires_at").ok().flatten(),
            created_at: stmt.read::<i64, _>("created_at").map_err(|e| e.to_string())?,
        });
    }
    Ok(shares)
}

async fn load_jobs(client: &Client, peer: &Peer) -> Result<Vec<RemoteJob>, String> {
    load_json_from_marker(client, peer, JOBS_MARKER).await
}

async fn save_jobs(
    app: &AppHandle,
    client: &Client,
    peer: &Peer,
    jobs: &[RemoteJob],
) -> Result<(), String> {
    let json_bytes = serde_json::to_vec(jobs).map_err(|e| e.to_string())?;
    publish_json(app, client, peer, JOBS_MARKER, "remote-jobs.json", &json_bytes).await
}

/// Processes every `Pending` job exactly once, using the same functions the
/// desktop's own UI calls for add/remove — never a separate, divergent code
/// path. Meant to be called exactly once per app launch, right after
/// Telegram connects (see the one-shot guard in `commands/auth.rs`).
pub async fn process_pending_jobs_once(
    app: &AppHandle,
    client: &Client,
    db_pool: &DbConnection,
    peer_cache: &PeerCache,
) -> Result<(), String> {
    // A scheduled/manual backup run does its own long-lived load-mutate-save
    // of the same backup_settings.json this function's add/remove jobs also
    // mutate (see cmd_add_backup_source/cmd_remove_backup_source). Skipping
    // this launch's job check while one is active avoids the more likely
    // half of that race — a job's change getting silently overwritten by
    // the backup run's own stale in-memory settings — at the cost of simply
    // retrying on the next launch instead.
    if app.state::<BackupState>().running.load(Ordering::SeqCst) {
        return Ok(());
    }

    let peer = resolve_peer(client, None, peer_cache).await?;
    let mut jobs = load_jobs(client, &peer).await?;
    if !jobs.iter().any(|job| job.status == RemoteJobStatus::Pending) {
        return Ok(());
    }

    // Set by the share job arms so the `[TD-SHARES]` blob only gets
    // republished when something actually changed — every publish costs an
    // upload plus a delete in Saved Messages.
    let mut shares_changed = false;

    for job in &mut jobs {
        if job.status != RemoteJobStatus::Pending {
            continue;
        }

        let (result, detail): (Result<(), String>, String) = match &job.action {
            RemoteJobAction::AddSource { path, display_name } => {
                let outcome = cmd_add_backup_source(path.clone(), None, None, app.clone())
                    .await
                    .map(|_| ());
                let name = display_name.clone().unwrap_or_else(|| path.clone());
                (outcome, format!("Remote job: add backup source \"{}\"", name))
            }
            RemoteJobAction::RemoveSource { source_id } => {
                let outcome = cmd_remove_backup_source(
                    source_id.clone(),
                    app.clone(),
                    app.state::<DbConnection>(),
                )
                .await
                .map(|_| ());
                (outcome, format!("Remote job: remove backup source \"{}\"", source_id))
            }
            RemoteJobAction::CopyEntry { source_id, relative_path, dest_source_id, dest_folder_path } => {
                let outcome = copy_or_move_entry(
                    app, source_id, relative_path, dest_source_id, dest_folder_path, false,
                );
                (outcome, format!("Remote job: copy \"{}\" to \"{}\"", relative_path, dest_folder_path))
            }
            RemoteJobAction::MoveEntry { source_id, relative_path, dest_source_id, dest_folder_path } => {
                let outcome = copy_or_move_entry(
                    app, source_id, relative_path, dest_source_id, dest_folder_path, true,
                );
                (outcome, format!("Remote job: move \"{}\" to \"{}\"", relative_path, dest_folder_path))
            }
            RemoteJobAction::CreateFolderShare {
                share_id, folder_id, folder_name,
                can_upload, can_download, can_update, can_delete,
                username, password_hash, expires_at,
            } => {
                let detail = format!("Remote job: create share link for \"{}\"", folder_name);
                let outcome = async {
                    validate_share_token(share_id)?;
                    if let Some(hash) = password_hash {
                        validate_bcrypt_hash(hash)?;
                    }
                    // Resolve the folder BEFORE inserting, so a wrong or
                    // unreachable id fails the job with a readable error
                    // instead of minting a token that 500s on every request
                    // forever. Mobile must send the raw channel id
                    // (`supergroupId`), not a TDLib `-100…` chat id — that
                    // mismatch is exactly what made its old share path dead.
                    resolve_peer(client, *folder_id, peer_cache)
                        .await
                        .map_err(|error| format!("Folder \"{}\" is not reachable: {}", folder_name, error))?;
                    crate::commands::sharing::create_folder_share_inner(
                        crate::commands::sharing::CreateFolderShareParams {
                            share_id: Some(share_id.clone()),
                            folder_id: *folder_id,
                            folder_name: folder_name.clone(),
                            can_upload: *can_upload,
                            can_download: *can_download,
                            can_update: *can_update,
                            can_delete: *can_delete,
                            username: username.clone(),
                            password_hash: password_hash.clone(),
                            expires_at: *expires_at,
                        },
                        db_pool,
                        app,
                    )
                    .map(|_| ())
                }
                .await;
                if outcome.is_ok() {
                    shares_changed = true;
                }
                (outcome, detail)
            }
            RemoteJobAction::RevokeFolderShare { share_id } => {
                let outcome = validate_share_token(share_id).and_then(|()| {
                    crate::commands::sharing::revoke_folder_share_inner(share_id, db_pool)
                });
                if outcome.is_ok() {
                    shares_changed = true;
                }
                (outcome, format!("Remote job: revoke share link {}", share_id))
            }
        };

        job.completed_at = Some(chrono::Utc::now().timestamp());
        match result {
            Ok(()) => {
                job.status = RemoteJobStatus::Completed;
                job.error = None;
                let _ = push_audit_log(db_pool, "remote_job_completed", &detail, None, None, None);
            }
            Err(error) => {
                job.status = RemoteJobStatus::Failed;
                job.error = Some(error.clone());
                let _ = push_audit_log(
                    db_pool,
                    "remote_job_failed",
                    &format!("{} — failed: {}", detail, error),
                    None,
                    None,
                    None,
                );
            }
        }
    }

    // Re-fetch right before saving and merge in any job mobile appended
    // while this run was busy processing (network round-trips to Telegram
    // for the catalog sync and each job's own work can take a while) —
    // without this, the plain overwrite below would silently erase a
    // just-submitted job that never made it into `jobs`. This narrows, but
    // doesn't fully close, the race: a job submitted from a stale mobile
    // read (before this device's completions land) can still overwrite a
    // just-completed job's status back to pending — a known, accepted
    // limitation of the "one JSON blob, no locking" design, same class as
    // the mobile Drive-sync race documented elsewhere in this app.
    if let Ok(latest) = load_jobs(client, &peer).await {
        let known_ids: std::collections::HashSet<String> =
            jobs.iter().map(|job| job.id.clone()).collect();
        for candidate in latest {
            if !known_ids.contains(&candidate.id) {
                jobs.push(candidate);
            }
        }
    }

    // Nothing ever pruned this list before, so it grew without bound — and
    // every read pays for it, since the whole blob is downloaded each time.
    // Settled jobs older than the retention window are dropped; pending ones
    // are always kept regardless of age, since a job can legitimately sit
    // unclaimed for a long time while the desktop app is closed.
    let prune_before = chrono::Utc::now().timestamp() - SETTLED_JOB_RETENTION_SECS;
    jobs.retain(|job| {
        job.status == RemoteJobStatus::Pending
            || job.completed_at.unwrap_or(job.created_at) >= prune_before
    });

    save_jobs(app, client, &peer, &jobs).await?;
    // The set of sources may have changed — keep the catalog in step.
    let _ = sync_catalog_to_telegram(app, client, peer_cache).await;
    // Only republish the share list when a share job actually ran, so an
    // ordinary backup job doesn't pay for an extra upload+delete round trip.
    if shares_changed {
        let _ = publish_shares_to_telegram(app, client, peer_cache).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_token_validation_accepts_only_generated_shape() {
        assert!(validate_share_token(&"a1b2c3d4e5f60718293a4b5c6d7e8f90".to_string()).is_ok());
        // Wrong length, uppercase, non-hex, and path-traversal attempts all
        // have to be rejected — this value becomes a URL segment and a
        // primary key.
        assert!(validate_share_token("tooshort").is_err());
        assert!(validate_share_token("A1B2C3D4E5F60718293A4B5C6D7E8F90").is_err());
        assert!(validate_share_token("../../etc/passwd").is_err());
        assert!(validate_share_token("a1b2c3d4e5f60718293a4b5c6d7e8f9").is_err());
    }

    #[test]
    fn bcrypt_hash_validation_accepts_real_hashes_and_rejects_junk() {
        // A genuine cost-12 hash (the cost desktop itself uses).
        let real = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.7ZUwNJ4hEuMPuTsjnKpEHkqXPHmVUqO";
        assert!(validate_bcrypt_hash(real).is_ok());
        // Plaintext leaking through instead of a hash is the failure this
        // guard exists to catch.
        assert!(validate_bcrypt_hash("hunter2").is_err());
        assert!(validate_bcrypt_hash("$1$oldmd5$whatever").is_err());
        assert!(validate_bcrypt_hash("$2b$12$tooshort").is_err());
    }

    #[test]
    fn bcrypt_cost_is_capped_so_verification_cannot_stall_the_server() {
        let padding = "C6UzMDM.H6dfI/f/IKcEe.7ZUwNJ4hEuMPuTsjnKpEHkqXPHmVUqO";
        assert!(validate_bcrypt_hash(&format!("$2b$31${}", padding)).is_err());
        assert!(validate_bcrypt_hash(&format!("$2b$03${}", padding)).is_err());
        assert!(validate_bcrypt_hash(&format!("$2b$14${}", padding)).is_ok());
    }

    #[test]
    fn create_share_action_round_trips_through_json() {
        let action = RemoteJobAction::CreateFolderShare {
            share_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90".to_string(),
            folder_id: Some(4336115350),
            folder_name: "Iceland 2026".to_string(),
            can_upload: true,
            can_download: true,
            can_update: false,
            can_delete: false,
            username: None,
            password_hash: Some("$2b$12$abc".to_string()),
            expires_at: Some(1_800_000_000),
        };
        let json = serde_json::to_string(&action).expect("serializes");
        assert!(json.contains(r#""type":"create_folder_share""#));
        match serde_json::from_str::<RemoteJobAction>(&json).expect("deserializes") {
            RemoteJobAction::CreateFolderShare { share_id, folder_id, expires_at, .. } => {
                assert_eq!(share_id, "a1b2c3d4e5f60718293a4b5c6d7e8f90");
                assert_eq!(folder_id, Some(4336115350));
                assert_eq!(expires_at, Some(1_800_000_000));
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn revoke_share_action_round_trips_through_json() {
        let action = RemoteJobAction::RevokeFolderShare {
            share_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90".to_string(),
        };
        let json = serde_json::to_string(&action).expect("serializes");
        assert!(json.contains(r#""type":"revoke_folder_share""#));
        assert!(matches!(
            serde_json::from_str::<RemoteJobAction>(&json).expect("deserializes"),
            RemoteJobAction::RevokeFolderShare { .. }
        ));
    }

    #[test]
    fn optional_share_fields_may_be_absent_for_forward_compatibility() {
        // A phone on an older build omits the optional keys entirely; the
        // `#[serde(default)]` attributes must let that still parse rather
        // than failing the whole blob (which would strand every job in it).
        let json = r#"{
            "type": "create_folder_share",
            "share_id": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
            "folder_id": null,
            "folder_name": "Saved Messages",
            "can_upload": false,
            "can_download": true,
            "can_update": false,
            "can_delete": false
        }"#;
        match serde_json::from_str::<RemoteJobAction>(json).expect("parses without optional keys") {
            RemoteJobAction::CreateFolderShare { username, password_hash, expires_at, .. } => {
                assert!(username.is_none());
                assert!(password_hash.is_none());
                assert!(expires_at.is_none());
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn existing_job_json_still_parses_after_adding_the_new_variants() {
        // Blobs already sitting in Saved Messages were written before this
        // change; adding enum variants must not break reading them.
        let json = r#"[{
            "id": "job-1",
            "action": { "type": "remove_source", "source_id": "src-9" },
            "status": "completed",
            "error": null,
            "created_at": 1786000000,
            "completed_at": 1786000060
        }]"#;
        let jobs: Vec<RemoteJob> = serde_json::from_str(json).expect("legacy blob parses");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, RemoteJobStatus::Completed);
    }

    #[test]
    fn share_publication_round_trips_with_the_fields_mobile_reads() {
        let publication = SharePublication {
            public: true,
            base_url: "https://random-words.trycloudflare.com".to_string(),
            updated_at: 1_786_000_000,
            shares: vec![PublishedShare {
                id: "a1b2c3d4e5f60718293a4b5c6d7e8f90".to_string(),
                folder_id: Some(42),
                folder_name: "Iceland 2026".to_string(),
                permissions: 0b0011,
                has_password: true,
                username: None,
                expires_at: None,
                created_at: 1_786_000_000,
            }],
        };
        let json = serde_json::to_string(&publication).expect("serializes");
        let parsed: SharePublication = serde_json::from_str(&json).expect("deserializes");
        assert!(parsed.public);
        assert_eq!(parsed.shares.len(), 1);
        assert_eq!(parsed.shares[0].permissions, 0b0011);
        // Password material must never appear in what mobile receives.
        assert!(!json.contains("password_hash"));
        assert!(!json.contains("$2b$"));
    }
}

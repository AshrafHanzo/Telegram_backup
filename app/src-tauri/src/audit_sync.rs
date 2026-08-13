//! Syncs the local audit log to the user's own Telegram "Saved Messages" so
//! it survives a reinstall/lost device — the local `audit_logs` SQLite table
//! (see commands/notifications.rs) is otherwise the only copy and dies with
//! the local install. Keeps a rolling 30-day window: anything older is
//! pruned locally before each sync, so the synced snapshot never grows
//! without bound.
//!
//! Mechanism: one message in Saved Messages, marked with a fixed caption so
//! it can be found again, carrying the full log as an attached JSON
//! document. Each sync deletes the previous marked message (if any) and
//! sends a fresh one — simpler than editing message media, and this run
//! infrequently enough (after each backup) that the extra round-trip is
//! immaterial.

use crate::commands::notifications::AuditLogRow;
use crate::commands::utils::resolve_peer;
use crate::db::DbConnection;
use grammers_client::types::{Media, Peer};
use grammers_client::{Client, InputMessage};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;

type PeerCache = Arc<RwLock<HashMap<i64, Peer>>>;

const AUDIT_LOG_MARKER: &str = "[TD-AUDIT-LOG]";
const RETENTION_DAYS: i64 = 30;
const SCAN_LIMIT: usize = 300;

fn prune_old_audit_logs(db_pool: &DbConnection) -> Result<(), String> {
    let cutoff = chrono::Utc::now().timestamp() - RETENTION_DAYS * 24 * 60 * 60;
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("DELETE FROM audit_logs WHERE created_at < ?")
        .map_err(|e| e.to_string())?;
    stmt.bind((1, cutoff)).map_err(|e| e.to_string())?;
    stmt.next().map_err(|e| e.to_string())?;
    Ok(())
}

fn load_recent_audit_logs(db_pool: &DbConnection) -> Result<Vec<AuditLogRow>, String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT * FROM audit_logs ORDER BY created_at ASC")
        .map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    while let sqlite::State::Row = stmt.next().map_err(|e| e.to_string())? {
        rows.push(AuditLogRow {
            id: stmt.read::<String, _>("id").map_err(|e| e.to_string())?,
            event_type: stmt.read::<String, _>("event_type").map_err(|e| e.to_string())?,
            detail: stmt.read::<String, _>("detail").map_err(|e| e.to_string())?,
            file_name: stmt.read::<Option<String>, _>("file_name").map_err(|e| e.to_string())?,
            bytes: stmt.read::<Option<i64>, _>("bytes").map_err(|e| e.to_string())?,
            source_id: stmt.read::<Option<String>, _>("source_id").map_err(|e| e.to_string())?,
            created_at: stmt.read::<i64, _>("created_at").map_err(|e| e.to_string())?,
        });
    }
    Ok(rows)
}

fn audit_log_exists(conn: &sqlite::Connection, id: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM audit_logs WHERE id = ?")
        .map_err(|e| e.to_string())?;
    stmt.bind((1, id)).map_err(|e| e.to_string())?;
    Ok(matches!(stmt.next().map_err(|e| e.to_string())?, sqlite::State::Row))
}

fn insert_audit_log_if_missing(db_pool: &DbConnection, row: &AuditLogRow) -> Result<bool, String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    if audit_log_exists(&conn, &row.id)? {
        return Ok(false);
    }
    let mut stmt = conn
        .prepare(
            "INSERT INTO audit_logs (id, event_type, detail, file_name, bytes, source_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .map_err(|e| e.to_string())?;
    stmt.bind((1, row.id.as_str())).map_err(|e| e.to_string())?;
    stmt.bind((2, row.event_type.as_str())).map_err(|e| e.to_string())?;
    stmt.bind((3, row.detail.as_str())).map_err(|e| e.to_string())?;
    match row.file_name.as_deref() {
        Some(name) => stmt.bind((4, name)).map_err(|e| e.to_string())?,
        None => stmt.bind((4, ())).map_err(|e| e.to_string())?,
    }
    match row.bytes {
        Some(b) => stmt.bind((5, b)).map_err(|e| e.to_string())?,
        None => stmt.bind((5, ())).map_err(|e| e.to_string())?,
    }
    match row.source_id.as_deref() {
        Some(id) => stmt.bind((6, id)).map_err(|e| e.to_string())?,
        None => stmt.bind((6, ())).map_err(|e| e.to_string())?,
    }
    stmt.bind((7, row.created_at)).map_err(|e| e.to_string())?;
    stmt.next().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Finds the existing marked message in Saved Messages, if any, scanning at
/// most `SCAN_LIMIT` recent messages (this app always keeps at most one such
/// message, deleting the old one before sending a new one, so it should
/// always be near the top).
async fn find_marker_message(
    client: &Client,
    peer: &grammers_client::types::Peer,
) -> Result<Option<grammers_client::types::Message>, String> {
    let mut iter = client.iter_messages(peer);
    let mut scanned = 0usize;
    while scanned < SCAN_LIMIT {
        let Some(msg) = iter.next().await.map_err(|e| e.to_string())? else {
            break;
        };
        scanned += 1;
        if msg.text() == AUDIT_LOG_MARKER && msg.media().is_some() {
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

/// Prunes anything older than the retention window, then replaces the
/// Saved-Messages snapshot with the current local log. Best-effort by
/// design at every call site — a failed sync never blocks the action that
/// triggered it (e.g. a backup run completing).
pub async fn sync_audit_log_to_telegram(
    app: &AppHandle,
    client: &Client,
    db_pool: &DbConnection,
    peer_cache: &PeerCache,
) -> Result<(), String> {
    prune_old_audit_logs(db_pool)?;
    let rows = load_recent_audit_logs(db_pool)?;
    let json_bytes = serde_json::to_vec(&rows).map_err(|e| e.to_string())?;

    let peer = resolve_peer(client, None, peer_cache).await?;

    // Find the existing marker but don't delete it yet — upload and send the
    // new one FIRST, so a failed upload/send (transient network drop) never
    // leaves Saved Messages with no audit-log snapshot at all. Only delete
    // the old one once the new one is confirmed sent.
    let existing = find_marker_message(client, &peer).await?;

    let temp_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let temp_path = temp_dir.join("audit-log-sync.json.tmp");
    tokio::fs::write(&temp_path, &json_bytes).await.map_err(|e| e.to_string())?;

    let mut file = tokio::fs::File::open(&temp_path).await.map_err(|e| e.to_string())?;
    let uploaded = client
        .upload_stream(&mut file, json_bytes.len(), "audit-log.json".to_string())
        .await
        .map_err(|e| e.to_string());
    let _ = tokio::fs::remove_file(&temp_path).await;
    let uploaded = uploaded?;

    let message = InputMessage::new().text(AUDIT_LOG_MARKER).file(uploaded);
    client.send_message(&peer, message).await.map_err(|e| e.to_string())?;

    if let Some(existing) = existing {
        let _ = client.delete_messages(&peer, &[existing.id()]).await;
    }
    Ok(())
}

/// Pulls the Saved-Messages snapshot down and merges it into the local
/// table (INSERT OR IGNORE, so this is safe to call even when local rows
/// already exist — it only ever fills in what's missing). Returns how many
/// rows were newly restored.
pub async fn restore_audit_log_from_telegram(
    client: &Client,
    db_pool: &DbConnection,
    peer_cache: &PeerCache,
) -> Result<usize, String> {
    let peer = resolve_peer(client, None, peer_cache).await?;
    let Some(message) = find_marker_message(client, &peer).await? else {
        return Ok(0);
    };
    let Some(media) = message.media() else { return Ok(0) };
    let bytes = download_media_bytes(client, &media).await?;
    let rows: Vec<AuditLogRow> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;

    let mut restored = 0usize;
    for row in &rows {
        if insert_audit_log_if_missing(db_pool, row)? {
            restored += 1;
        }
    }
    Ok(restored)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

async fn connected_client(
    tg_state: &tauri::State<'_, crate::commands::TelegramState>,
) -> Result<Client, String> {
    tg_state
        .client
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Telegram is not connected".to_string())
}

#[tauri::command]
pub async fn cmd_sync_audit_log_to_telegram(
    app: AppHandle,
    db_pool: tauri::State<'_, DbConnection>,
    tg_state: tauri::State<'_, crate::commands::TelegramState>,
) -> Result<(), String> {
    let client = connected_client(&tg_state).await?;
    sync_audit_log_to_telegram(&app, &client, &db_pool, &tg_state.peer_cache).await
}

#[tauri::command]
pub async fn cmd_restore_audit_log_from_telegram(
    db_pool: tauri::State<'_, DbConnection>,
    tg_state: tauri::State<'_, crate::commands::TelegramState>,
) -> Result<usize, String> {
    let client = connected_client(&tg_state).await?;
    restore_audit_log_from_telegram(&client, &db_pool, &tg_state.peer_cache).await
}

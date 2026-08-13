//! In-app notification bell + itemized audit log. Notifications are
//! short-lived, user-facing events (upload complete, backup complete, a
//! calculation awaiting approve/deny); the audit log is the permanent,
//! detailed record of what actually happened, one row per event.
//!
//! Both tables are plain SQLite (see `db.rs::run_notifications_migration`)
//! — no settings-file involved, since these are naturally append-heavy logs
//! rather than a small piece of configuration.

use crate::db::DbConnection;
use serde::{Deserialize, Serialize};
use tauri::State;

fn generate_id() -> String {
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..8).map(|_| rand::Rng::random(&mut rng)).collect();
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NotificationRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub message: String,
    pub created_at: i64,
    pub read: bool,
    pub requires_action: bool,
    pub action_resolved: bool,
    pub action_payload: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuditLogRow {
    pub id: String,
    pub event_type: String,
    pub detail: String,
    pub file_name: Option<String>,
    pub bytes: Option<i64>,
    pub source_id: Option<String>,
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// Plain functions other modules (backup.rs, fs.rs) call directly to record
// an event — not Tauri commands themselves, since the frontend never needs
// to create these directly, only read/manage them.
// ---------------------------------------------------------------------------

pub fn push_notification(
    db_pool: &DbConnection,
    kind: &str,
    title: &str,
    message: &str,
    requires_action: bool,
    action_payload: Option<&str>,
) -> Result<String, String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let id = generate_id();
    let mut stmt = conn
        .prepare(
            "INSERT INTO notifications (id, kind, title, message, created_at, read, requires_action, action_resolved, action_payload)
             VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?)",
        )
        .map_err(|e| e.to_string())?;
    stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
    stmt.bind((2, kind)).map_err(|e| e.to_string())?;
    stmt.bind((3, title)).map_err(|e| e.to_string())?;
    stmt.bind((4, message)).map_err(|e| e.to_string())?;
    stmt.bind((5, now_unix())).map_err(|e| e.to_string())?;
    stmt.bind((6, requires_action as i64)).map_err(|e| e.to_string())?;
    match action_payload {
        Some(payload) => stmt.bind((7, payload)).map_err(|e| e.to_string())?,
        None => stmt.bind((7, ())).map_err(|e| e.to_string())?,
    }
    stmt.next().map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn push_audit_log(
    db_pool: &DbConnection,
    event_type: &str,
    detail: &str,
    file_name: Option<&str>,
    bytes: Option<i64>,
    source_id: Option<&str>,
) -> Result<(), String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "INSERT INTO audit_logs (id, event_type, detail, file_name, bytes, source_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .map_err(|e| e.to_string())?;
    stmt.bind((1, generate_id().as_str())).map_err(|e| e.to_string())?;
    stmt.bind((2, event_type)).map_err(|e| e.to_string())?;
    stmt.bind((3, detail)).map_err(|e| e.to_string())?;
    match file_name {
        Some(name) => stmt.bind((4, name)).map_err(|e| e.to_string())?,
        None => stmt.bind((4, ())).map_err(|e| e.to_string())?,
    }
    match bytes {
        Some(b) => stmt.bind((5, b)).map_err(|e| e.to_string())?,
        None => stmt.bind((5, ())).map_err(|e| e.to_string())?,
    }
    match source_id {
        Some(id) => stmt.bind((6, id)).map_err(|e| e.to_string())?,
        None => stmt.bind((6, ())).map_err(|e| e.to_string())?,
    }
    stmt.bind((7, now_unix())).map_err(|e| e.to_string())?;
    stmt.next().map_err(|e| e.to_string())?;
    Ok(())
}

fn read_notification_row(stmt: &sqlite::Statement) -> Result<NotificationRow, String> {
    Ok(NotificationRow {
        id: stmt.read::<String, _>("id").map_err(|e| e.to_string())?,
        kind: stmt.read::<String, _>("kind").map_err(|e| e.to_string())?,
        title: stmt.read::<String, _>("title").map_err(|e| e.to_string())?,
        message: stmt.read::<String, _>("message").map_err(|e| e.to_string())?,
        created_at: stmt.read::<i64, _>("created_at").map_err(|e| e.to_string())?,
        read: stmt.read::<i64, _>("read").map_err(|e| e.to_string())? != 0,
        requires_action: stmt.read::<i64, _>("requires_action").map_err(|e| e.to_string())? != 0,
        action_resolved: stmt.read::<i64, _>("action_resolved").map_err(|e| e.to_string())? != 0,
        action_payload: stmt.read::<Option<String>, _>("action_payload").ok().flatten(),
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cmd_list_notifications(db_pool: State<'_, DbConnection>) -> Result<Vec<NotificationRow>, String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200")
        .map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    while let sqlite::State::Row = stmt.next().map_err(|e| e.to_string())? {
        rows.push(read_notification_row(&stmt)?);
    }
    Ok(rows)
}

#[tauri::command]
pub async fn cmd_mark_notification_read(id: String, db_pool: State<'_, DbConnection>) -> Result<(), String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("UPDATE notifications SET read = 1 WHERE id = ?")
        .map_err(|e| e.to_string())?;
    stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
    stmt.next().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_mark_all_notifications_read(db_pool: State<'_, DbConnection>) -> Result<(), String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE notifications SET read = 1 WHERE read = 0").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_delete_notification(id: String, db_pool: State<'_, DbConnection>) -> Result<(), String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("DELETE FROM notifications WHERE id = ?").map_err(|e| e.to_string())?;
    stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
    stmt.next().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_delete_all_notifications(db_pool: State<'_, DbConnection>) -> Result<(), String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM notifications").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_list_audit_logs(db_pool: State<'_, DbConnection>) -> Result<Vec<AuditLogRow>, String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 1000")
        .map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    while let sqlite::State::Row = stmt.next().map_err(|e| e.to_string())? {
        rows.push(AuditLogRow {
            id: stmt.read::<String, _>("id").map_err(|e| e.to_string())?,
            event_type: stmt.read::<String, _>("event_type").map_err(|e| e.to_string())?,
            detail: stmt.read::<String, _>("detail").map_err(|e| e.to_string())?,
            file_name: stmt.read::<Option<String>, _>("file_name").ok().flatten(),
            bytes: stmt.read::<Option<i64>, _>("bytes").ok().flatten(),
            source_id: stmt.read::<Option<String>, _>("source_id").ok().flatten(),
            created_at: stmt.read::<i64, _>("created_at").map_err(|e| e.to_string())?,
        });
    }
    Ok(rows)
}

#[tauri::command]
pub async fn cmd_delete_audit_log(id: String, db_pool: State<'_, DbConnection>) -> Result<(), String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("DELETE FROM audit_logs WHERE id = ?").map_err(|e| e.to_string())?;
    stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
    stmt.next().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_delete_all_audit_logs(db_pool: State<'_, DbConnection>) -> Result<(), String> {
    let conn = db_pool.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM audit_logs").map_err(|e| e.to_string())
}

/// Approve/deny a notification that carries an action (currently only
/// "Backup All"'s calculate step). Approving here only flips the flag and
/// hands the parsed payload back to the caller — the actual "go add these
/// folders and start backing them up" logic lives in backup.rs, which is
/// where the rest of the backup domain logic already lives.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BackupAllPayload {
    pub paths: Vec<String>,
    pub total_bytes: u64,
    pub total_files: u32,
}

#[tauri::command]
pub async fn cmd_respond_to_notification(
    id: String,
    approved: bool,
    app: tauri::AppHandle,
    db_pool: State<'_, DbConnection>,
) -> Result<(), String> {
    let payload = {
        let conn = db_pool.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT action_payload, kind FROM notifications WHERE id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
        if let sqlite::State::Row = stmt.next().map_err(|e| e.to_string())? {
            let kind = stmt.read::<String, _>("kind").map_err(|e| e.to_string())?;
            let raw = stmt.read::<Option<String>, _>("action_payload").ok().flatten();
            raw.map(|r| (kind, r))
        } else {
            None
        }
    };

    {
        let conn = db_pool.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("UPDATE notifications SET action_resolved = 1, read = 1 WHERE id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
        stmt.next().map_err(|e| e.to_string())?;
    }

    if !approved {
        return Ok(());
    }

    if let Some((kind, raw_payload)) = payload {
        if kind == "backup_all_calculated" {
            let parsed: BackupAllPayload = serde_json::from_str(&raw_payload).map_err(|e| e.to_string())?;
            crate::commands::backup::run_backup_all_approved(&app, parsed.paths).await?;
        }
    }

    Ok(())
}

//! "Backup" feature: mirrors one or more local folders into dedicated,
//! hidden Telegram channels (one channel per source folder), on a daily
//! schedule and/or on demand, with a Restore path back to local disk.
//!
//! Local directory nesting is flattened by uploading each file with its
//! path *relative to its source root* as the Telegram document name (e.g.
//! `Docs/report.pdf`) — see `run_backup_source` — so a single flat channel
//! can represent an arbitrarily nested local tree, and Restore can rebuild
//! that tree from the channel's file listing alone with no separate index.

use futures::stream::{self, StreamExt};
use grammers_tl_types as tl;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bandwidth::BandwidthManager;
use crate::crypto::state::CryptoState;
use crate::db::DbConnection;
use crate::vpn_optimizer::NetworkConfig;
use crate::TelegramState;

pub const DEFAULT_BACKUP_HOUR: u8 = 12;
pub const DEFAULT_BACKUP_MINUTE: u8 = 0;

/// How many files a single backup/restore run will transfer concurrently.
/// Kept small and fixed for v1 — this runs headless (no renderer to host the
/// frontend's usual queue-concurrency UI), and `cmd_upload_file_inner`'s own
/// bandwidth reservation still throttles aggregate throughput on top of this.
const TRANSFER_CONCURRENCY: usize = 3;

/// A missed scheduled run is only caught up once per calendar day, so a user
/// who opens/closes the app repeatedly around noon doesn't trigger repeated
/// catch-up runs.
const CATCH_UP_WINDOW_SECS: i64 = 86_400;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BackupSourceFolder {
    pub id: String,
    pub local_path: String,
    pub display_name: String,
    pub channel_id: Option<i64>,
    pub enabled: bool,
    pub last_run_at: Option<i64>,
    pub last_run_status: Option<String>,
    pub last_error: Option<String>,
    /// Paths relative to `local_path` (forward-slash separated) to skip
    /// entirely — a folder entry excludes everything nested under it too,
    /// not just its own direct files. `#[serde(default)]` so existing
    /// configs saved before this field existed still parse.
    #[serde(default)]
    pub excluded_paths: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BackupSettingsFile {
    pub enabled: bool,
    pub schedule_hour: u8,
    pub schedule_minute: u8,
    pub sources: Vec<BackupSourceFolder>,
    pub last_scheduled_run_at: Option<i64>,
    pub last_scheduled_run_status: Option<String>,
}

impl Default for BackupSettingsFile {
    fn default() -> Self {
        Self {
            enabled: false,
            schedule_hour: DEFAULT_BACKUP_HOUR,
            schedule_minute: DEFAULT_BACKUP_MINUTE,
            sources: Vec::new(),
            last_scheduled_run_at: None,
            last_scheduled_run_status: None,
        }
    }
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct BackupRunSummary {
    pub sources_processed: u32,
    pub files_uploaded: u32,
    pub files_skipped: u32,
    pub files_failed: u32,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct RestoreRunSummary {
    pub restored: u32,
    pub skipped: u32,
    pub failed: u32,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BackupStatus {
    pub running: bool,
    pub current_source_id: Option<String>,
    pub current_files_done: u32,
    pub current_files_total: u32,
    pub next_scheduled_run_at: Option<i64>,
    pub settings: BackupSettingsFile,
}

#[derive(Serialize, Clone)]
struct BackupProgressPayload {
    phase: &'static str, // "backup" | "restore"
    source_id: String,
    files_done: u32,
    files_total: u32,
    current_file: Option<String>,
}

/// Managed Tauri state: run-guard + live progress + a handle to cancel the
/// previous scheduler loop when settings change (mirrors the pattern already
/// used for `TelegramState.runner_shutdown`).
pub struct BackupState {
    pub running: Arc<AtomicBool>,
    pub current: Arc<StdMutex<Option<(String, u32, u32)>>>,
    pub scheduler_shutdown: Arc<StdMutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    // Checked between files (and before starting each new source) by an
    // in-progress run; cmd_cancel_backup sets it, the run loop clears it
    // again the next time it starts so a stale cancel doesn't linger.
    pub cancel_requested: Arc<AtomicBool>,
}

impl BackupState {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            current: Arc::new(StdMutex::new(None)),
            scheduler_shutdown: Arc::new(StdMutex::new(None)),
            cancel_requested: Arc::new(AtomicBool::new(false)),
        }
    }
}

// ---------------------------------------------------------------------------
// Settings persistence — same atomic tmp-file+rename(+copy fallback) pattern
// as `commands::webdav_settings`.
// ---------------------------------------------------------------------------

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("backup_settings.json"))
}

pub fn load_settings(app: &AppHandle) -> BackupSettingsFile {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &BackupSettingsFile) -> Result<(), String> {
    let path = settings_path(app)?;
    let temp_path = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    std::fs::write(&temp_path, contents).map_err(|error| error.to_string())?;
    if std::fs::rename(&temp_path, &path).is_ok() {
        return Ok(());
    }
    // Windows cannot atomically rename over an existing file.
    std::fs::copy(&temp_path, &path).map_err(|error| error.to_string())?;
    std::fs::remove_file(&temp_path).map_err(|error| error.to_string())
}

fn generate_source_id() -> String {
    let mut rng = rand::rng();
    let bytes: Vec<u8> = (0..8).map(|_| rand::Rng::random(&mut rng)).collect();
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

// ---------------------------------------------------------------------------
// Ledger (backup_file_state) helpers
// ---------------------------------------------------------------------------

fn ledger_lookup(
    conn: &sqlite::Connection,
    source_id: &str,
    relative_path: &str,
) -> Option<(i32, u64, i64)> {
    let mut stmt = conn
        .prepare("SELECT message_id, size, mtime FROM backup_file_state WHERE source_id = ? AND relative_path = ?")
        .ok()?;
    stmt.bind((1, source_id)).ok()?;
    stmt.bind((2, relative_path)).ok()?;
    if matches!(stmt.next(), Ok(sqlite::State::Row)) {
        let message_id = stmt.read::<i64, _>(0).ok()? as i32;
        let size = stmt.read::<i64, _>(1).ok()? as u64;
        let mtime = stmt.read::<i64, _>(2).ok()?;
        Some((message_id, size, mtime))
    } else {
        None
    }
}

fn ledger_upsert(
    conn: &sqlite::Connection,
    source_id: &str,
    relative_path: &str,
    message_id: i32,
    size: u64,
    mtime: i64,
) -> Result<(), String> {
    let uploaded_at = chrono::Utc::now().timestamp();
    let mut stmt = conn
        .prepare(
            "INSERT INTO backup_file_state (source_id, relative_path, message_id, size, mtime, uploaded_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_id, relative_path) DO UPDATE SET
                message_id = excluded.message_id,
                size = excluded.size,
                mtime = excluded.mtime,
                uploaded_at = excluded.uploaded_at",
        )
        .map_err(|error| error.to_string())?;
    stmt.bind((1, source_id)).map_err(|error| error.to_string())?;
    stmt.bind((2, relative_path)).map_err(|error| error.to_string())?;
    stmt.bind((3, message_id as i64)).map_err(|error| error.to_string())?;
    stmt.bind((4, size as i64)).map_err(|error| error.to_string())?;
    stmt.bind((5, mtime)).map_err(|error| error.to_string())?;
    stmt.bind((6, uploaded_at)).map_err(|error| error.to_string())?;
    stmt.next().map_err(|error| error.to_string())?;
    Ok(())
}

fn ledger_remove_source(conn: &sqlite::Connection, source_id: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare("DELETE FROM backup_file_state WHERE source_id = ?")
        .map_err(|error| error.to_string())?;
    stmt.bind((1, source_id)).map_err(|error| error.to_string())?;
    stmt.next().map_err(|error| error.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

fn next_run_timestamp(hour: u8, minute: u8) -> i64 {
    use chrono::{Local, TimeZone};

    let now = Local::now();
    let today = now
        .date_naive()
        .and_hms_opt(hour as u32, minute as u32, 0)
        .unwrap_or_else(|| now.date_naive().and_hms_opt(12, 0, 0).unwrap());

    let target_naive = if today <= now.naive_local() {
        today + chrono::Duration::days(1)
    } else {
        today
    };

    match Local.from_local_datetime(&target_naive) {
        chrono::LocalResult::Single(dt) => dt.timestamp(),
        chrono::LocalResult::Ambiguous(dt, _) => dt.timestamp(),
        // Local time doesn't exist (DST spring-forward gap) — try again in an hour.
        chrono::LocalResult::None => now.timestamp() + 3600,
    }
}

/// (Re)starts the daily backup scheduler loop, cancelling any previously
/// running one first. Safe to call any time settings change — mirrors
/// `restart_webdav_server`/`restart_api_server`'s restart-on-settings-change
/// convention. Should also be called once from `setup()` on every launch.
pub fn restart_backup_scheduler(app: &AppHandle) {
    let backup_state = app.state::<BackupState>();
    if let Some(tx) = backup_state.scheduler_shutdown.lock().unwrap().take() {
        let _ = tx.send(());
    }
    let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
    *backup_state.scheduler_shutdown.lock().unwrap() = Some(tx);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let settings = load_settings(&app_handle);
            let any_enabled_source = settings.sources.iter().any(|source| source.enabled);

            if !settings.enabled || !any_enabled_source {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => continue,
                    _ = &mut rx => return,
                }
            }

            let now_ts = chrono::Utc::now().timestamp();
            let overdue = settings
                .last_scheduled_run_at
                .map(|last| now_ts - last > CATCH_UP_WINDOW_SECS)
                .unwrap_or(true);

            if overdue {
                log::info!("Backup scheduler: running missed/first scheduled backup now");
                if let Err(error) = run_backup(&app_handle, None, true).await {
                    log::warn!("Scheduled backup did not run: {}", error);
                }
                // Always wait a bit before re-checking, even on failure, so a
                // persistently-disconnected client can't spin this into a
                // tight retry loop.
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {},
                    _ = &mut rx => return,
                }
                continue;
            }

            let next = next_run_timestamp(settings.schedule_hour, settings.schedule_minute);
            let sleep_secs = (next - chrono::Utc::now().timestamp()).max(1) as u64;
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(sleep_secs)) => {
                    if let Err(error) = run_backup(&app_handle, None, true).await {
                        log::warn!("Scheduled backup failed to start: {}", error);
                    }
                }
                _ = &mut rx => return,
            }
        }
    });
}

// ---------------------------------------------------------------------------
// The backup routine
// ---------------------------------------------------------------------------

enum FileOutcome {
    Uploaded,
    Skipped,
    Failed(String),
}

struct SourceRunResult {
    channel_id: i64,
    uploaded: u32,
    skipped: u32,
    failed: u32,
    errors: Vec<String>,
}

/// Runs a backup of all enabled sources (or just `only_source_ids` if given).
/// Called both by `cmd_backup_now` (interactive) and the scheduler loop
/// (`is_scheduled = true`); a single run-guard on `BackupState` keeps the two
/// from overlapping.
pub async fn run_backup(
    app: &AppHandle,
    only_source_ids: Option<Vec<String>>,
    is_scheduled: bool,
) -> Result<BackupRunSummary, String> {
    let backup_state = app.state::<BackupState>();
    if backup_state.running.swap(true, Ordering::SeqCst) {
        return Err("A backup or restore is already in progress".to_string());
    }
    backup_state.cancel_requested.store(false, Ordering::SeqCst);
    let result = run_backup_locked(app, only_source_ids, is_scheduled).await;
    backup_state.running.store(false, Ordering::SeqCst);
    backup_state.cancel_requested.store(false, Ordering::SeqCst);
    *backup_state.current.lock().unwrap() = None;
    result
}

async fn run_backup_locked(
    app: &AppHandle,
    only_source_ids: Option<Vec<String>>,
    is_scheduled: bool,
) -> Result<BackupRunSummary, String> {
    let mut settings = load_settings(app);
    let mut summary = BackupRunSummary::default();

    let target_ids: Option<std::collections::HashSet<String>> =
        only_source_ids.map(|ids| ids.into_iter().collect());

    let tg_state = app.state::<TelegramState>();
    let client_opt = { tg_state.client.lock().await.clone() };
    let Some(client) = client_opt else {
        return Err("Telegram is not connected".to_string());
    };

    let source_indices: Vec<usize> = settings
        .sources
        .iter()
        .enumerate()
        .filter(|(_, source)| {
            source.enabled
                && target_ids
                    .as_ref()
                    .map(|ids| ids.contains(&source.id))
                    .unwrap_or(true)
        })
        .map(|(index, _)| index)
        .collect();

    let backup_state = app.state::<BackupState>();
    for index in source_indices {
        if backup_state.cancel_requested.load(Ordering::SeqCst) {
            summary.errors.push("Backup cancelled".to_string());
            break;
        }
        let source_snapshot = settings.sources[index].clone();
        let db_pool = app.state::<DbConnection>();

        match run_backup_source(app, &client, &db_pool, &source_snapshot).await {
            Ok(result) => {
                settings.sources[index].channel_id = Some(result.channel_id);
                settings.sources[index].last_run_at = Some(chrono::Utc::now().timestamp());
                settings.sources[index].last_run_status = Some(
                    if result.failed == 0 { "success" } else { "partial" }.to_string(),
                );
                settings.sources[index].last_error = None;
                summary.files_uploaded += result.uploaded;
                summary.files_skipped += result.skipped;
                summary.files_failed += result.failed;
                summary.errors.extend(result.errors);
            }
            Err(error) => {
                settings.sources[index].last_run_status = Some("failed".to_string());
                settings.sources[index].last_error = Some(error.clone());
                summary
                    .errors
                    .push(format!("{}: {}", source_snapshot.display_name, error));
                summary.files_failed += 1;
            }
        }

        summary.sources_processed += 1;
        // Persist after each source so a crash mid-run doesn't lose the
        // channel_id/status of sources already completed.
        let _ = save_settings(app, &settings);
    }

    if is_scheduled {
        settings.last_scheduled_run_at = Some(chrono::Utc::now().timestamp());
        settings.last_scheduled_run_status =
            Some(if summary.files_failed == 0 { "success" } else { "partial" }.to_string());
        save_settings(app, &settings)?;
    }

    if summary.sources_processed > 0 {
        let db_pool = app.state::<DbConnection>();
        let title = if summary.files_failed == 0 { "Backup complete" } else { "Backup finished with issues" };
        let message = format!(
            "{} uploaded, {} unchanged{}",
            summary.files_uploaded,
            summary.files_skipped,
            if summary.files_failed > 0 { format!(", {} failed", summary.files_failed) } else { String::new() },
        );
        let _ = crate::commands::notifications::push_notification(
            &db_pool, "backup_complete", title, &message, false, None,
        );

        // Best-effort: keep the Saved-Messages audit log snapshot current so
        // it survives a lost/reinstalled device. Never blocks or fails the
        // backup itself.
        let _ = crate::audit_sync::sync_audit_log_to_telegram(
            app,
            &client,
            &db_pool,
            &tg_state.peer_cache,
        )
        .await;

        // Best-effort: refresh the mobile-browsable catalog so it reflects
        // what just changed, not just whatever it looked like when a remote
        // job last ran.
        let _ = crate::remote_catalog::sync_catalog_to_telegram(app, &client, &tg_state.peer_cache)
            .await;
    }

    Ok(summary)
}

async fn run_backup_source(
    app: &AppHandle,
    client: &grammers_client::Client,
    db_pool: &DbConnection,
    source: &BackupSourceFolder,
) -> Result<SourceRunResult, String> {
    let tg_state = app.state::<TelegramState>();

    let channel_id = match source.channel_id {
        Some(id) => id,
        None => {
            let title = format!("{} [TD-Backup]", source.display_name);
            let about = "Telegram Drive automatic backup folder — managed by the app, do not rename or delete manually.\n[telegram-drive-backup-folder]".to_string();
            crate::commands::fs::create_channel_raw(title, about, client, &tg_state.peer_cache)
                .await?
        }
    };

    let peer = crate::commands::utils::resolve_peer(client, Some(channel_id), &tg_state.peer_cache)
        .await?;

    let local_root = PathBuf::from(&source.local_path);
    if !local_root.is_dir() {
        return Err(format!("'{}' is not a directory", source.local_path));
    }

    // Normalize once so exclusion checks below are a plain string
    // comparison regardless of how the path was originally typed/stored.
    let excluded: Vec<String> = source
        .excluded_paths
        .iter()
        .map(|p| p.replace('\\', "/").trim_matches('/').to_string())
        .filter(|p| !p.is_empty())
        .collect();

    let entries: Vec<PathBuf> = walkdir::WalkDir::new(&local_root)
        .into_iter()
        // filter_entry skips descending into an excluded directory
        // entirely, rather than walking it and discarding results
        // afterward — a large excluded folder costs nothing here.
        .filter_entry(|entry| {
            if excluded.is_empty() || entry.path() == local_root {
                return true;
            }
            let Ok(relative) = entry.path().strip_prefix(&local_root) else {
                return true;
            };
            let relative_str = relative.to_string_lossy().replace('\\', "/");
            !excluded.iter().any(|excluded_path| {
                relative_str == *excluded_path
                    || relative_str.starts_with(&format!("{}/", excluded_path))
            })
        })
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .collect();

    {
        let backup_state = app.state::<BackupState>();
        let mut current = backup_state.current.lock().unwrap();
        *current = Some((source.id.clone(), 0, entries.len() as u32));
    }

    let files_done = Arc::new(AtomicU32::new(0));
    let files_total = entries.len() as u32;

    let outcomes: Vec<FileOutcome> = stream::iter(entries)
        .map(|file_path| {
            let app = app.clone();
            let client = client.clone();
            let peer = peer.clone();
            let db_pool = db_pool.clone();
            let source_id = source.id.clone();
            let local_root = local_root.clone();
            let files_done = files_done.clone();
            async move {
                // Checked per-file rather than only between sources so a
                // cancel takes effect quickly even mid-source; files already
                // in flight when this flips still finish (never left
                // half-uploaded), just no new ones start after.
                let cancelled = app.state::<BackupState>().cancel_requested.load(Ordering::SeqCst);
                let outcome = if cancelled {
                    FileOutcome::Skipped
                } else {
                    backup_one_file(
                        &app,
                        &client,
                        &peer,
                        &db_pool,
                        &source_id,
                        channel_id,
                        &local_root,
                        &file_path,
                    )
                    .await
                };

                let done = files_done.fetch_add(1, Ordering::SeqCst) + 1;
                {
                    let backup_state = app.state::<BackupState>();
        let mut current = backup_state.current.lock().unwrap();
                    *current = Some((source_id.clone(), done, files_total));
                }
                let relative = file_path
                    .strip_prefix(&local_root)
                    .unwrap_or(&file_path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let _ = app.emit(
                    "backup-progress",
                    BackupProgressPayload {
                        phase: "backup",
                        source_id,
                        files_done: done,
                        files_total,
                        current_file: Some(relative),
                    },
                );

                outcome
            }
        })
        .buffer_unordered(TRANSFER_CONCURRENCY)
        .collect()
        .await;

    let mut result = SourceRunResult {
        channel_id,
        uploaded: 0,
        skipped: 0,
        failed: 0,
        errors: Vec::new(),
    };
    for outcome in outcomes {
        match outcome {
            FileOutcome::Uploaded => result.uploaded += 1,
            FileOutcome::Skipped => result.skipped += 1,
            FileOutcome::Failed(error) => {
                result.failed += 1;
                result.errors.push(error);
            }
        }
    }

    Ok(result)
}

async fn backup_one_file(
    app: &AppHandle,
    client: &grammers_client::Client,
    peer: &grammers_client::types::Peer,
    db_pool: &DbConnection,
    source_id: &str,
    channel_id: i64,
    local_root: &Path,
    file_path: &Path,
) -> FileOutcome {
    let relative = match file_path.strip_prefix(local_root) {
        Ok(relative) => relative,
        Err(_) => {
            return FileOutcome::Failed(format!(
                "{}: could not compute a relative path",
                file_path.display()
            ))
        }
    };
    let relative_str = relative.to_string_lossy().replace('\\', "/");
    if relative_str.is_empty() {
        return FileOutcome::Failed(format!("{}: empty relative path", file_path.display()));
    }

    let metadata = match tokio::fs::metadata(file_path).await {
        Ok(metadata) => metadata,
        Err(error) => return FileOutcome::Failed(format!("{}: {}", relative_str, error)),
    };
    let size = metadata.len();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);

    let previous = {
        match db_pool.lock() {
            Ok(conn) => ledger_lookup(&conn, source_id, &relative_str),
            Err(_) => {
                return FileOutcome::Failed(format!(
                    "{}: backup ledger lock was poisoned",
                    relative_str
                ))
            }
        }
    };

    if let Some((previous_message_id, previous_size, previous_mtime)) = previous {
        if previous_size == size && previous_mtime == mtime {
            // The local file looks unchanged, but that alone doesn't mean the
            // backed-up copy is still on Telegram — it may have been deleted
            // (in this app or directly in Telegram) since the last run. Verify
            // before trusting the ledger, so a deleted backup actually gets
            // re-uploaded instead of being silently skipped forever.
            //
            // Note: a deleted message does NOT come back as `None` here —
            // Telegram returns a `Message::Empty` placeholder in its place,
            // which still round-trips as `Some(Message)`. Both cases must be
            // treated as "gone".
            let still_exists = client
                .get_messages_by_id(peer, &[previous_message_id])
                .await
                .map(|messages| {
                    matches!(
                        messages.first(),
                        Some(Some(msg)) if !matches!(msg.raw, tl::enums::Message::Empty(_))
                    )
                })
                .unwrap_or(true); // network hiccup — assume fine rather than re-upload needlessly
            if still_exists {
                return FileOutcome::Skipped;
            }
            log::info!(
                "Backup ledger for {} pointed at message {} which no longer exists on Telegram — re-uploading.",
                relative_str, previous_message_id
            );
        }
    }

    let transfer_id = format!("backup-{}-{}", source_id, simple_hash(&relative_str));

    let upload_result = crate::commands::fs::cmd_upload_file_inner(
        file_path.to_string_lossy().to_string(),
        Some(channel_id),
        Some(transfer_id),
        None,
        None,
        None,
        app.clone(),
        app.state::<TelegramState>(),
        app.state::<Arc<BandwidthManager>>(),
        app.state::<Arc<NetworkConfig>>(),
        app.state::<CryptoState>(),
        app.state::<DbConnection>(),
        Some(relative_str.clone()),
    )
    .await;

    let new_message_id: i32 = match upload_result {
        Ok(id_str) => match id_str.parse::<i32>() {
            Ok(id) => id,
            Err(_) => {
                return FileOutcome::Failed(format!(
                    "{}: upload succeeded but returned an unexpected result",
                    relative_str
                ))
            }
        },
        Err(error) => return FileOutcome::Failed(format!("{}: {}", relative_str, error)),
    };

    // Record the successful upload in the local ledger so a future run doesn't
    // needlessly re-upload it. This write can't be made truly atomic with the
    // Telegram upload above — they're two different systems — so if the
    // process crashes/is killed in between, the file ends up live on Telegram
    // with no ledger entry, and the next run will re-upload it (mirroring the
    // "ledger points at a message that no longer exists" case handled above,
    // just in the other direction). A duplicate re-upload is the accepted,
    // safe failure mode here: it wastes storage/bandwidth but never loses
    // data. What IS worth guarding against is a *transient* local failure
    // (a momentarily poisoned mutex, a locked/busy DB file) turning into that
    // same duplicate needlessly, so retry once after a short delay before
    // giving up.
    //
    // Known remaining gap: a hard crash between the upload and the ledger
    // write is not recoverable by a retry, and there is no reconciliation
    // pass that scans the backup channel for orphaned messages (uploaded but
    // never recorded) to adopt or delete-duplicate them. Closing that gap
    // fully would require such a scan; this retry only narrows the window.
    let mut ledger_write_error: Option<String> = None;
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        match db_pool.lock() {
            Ok(conn) => match ledger_upsert(&conn, source_id, &relative_str, new_message_id, size, mtime) {
                Ok(()) => {
                    ledger_write_error = None;
                    break;
                }
                Err(error) => ledger_write_error = Some(format!("ledger_upsert failed: {}", error)),
            },
            Err(_) => ledger_write_error = Some("backup ledger lock was poisoned".to_string()),
        }
    }
    if let Some(error) = ledger_write_error {
        log::warn!(
            "Backup ledger update failed for {} after retry: {} — message {} IS uploaded to Telegram, but the ledger has no record of it, so a future backup run may re-upload it as a duplicate.",
            relative_str, error, new_message_id
        );
    }

    // File changed since last backup: the new content is already safely
    // uploaded, so delete the stale message now. Best-effort — a leftover
    // stale message is harmless clutter, but we never want to risk deleting
    // before the replacement upload has succeeded.
    if let Some((previous_message_id, _, _)) = previous {
        if previous_message_id != new_message_id {
            if let Err(error) = client.delete_messages(peer, &[previous_message_id]).await {
                log::warn!(
                    "Failed to delete superseded backup message {} for {}: {}",
                    previous_message_id, relative_str, error
                );
            }
        }
    }

    let _ = crate::commands::notifications::push_audit_log(
        db_pool,
        "backup_file_uploaded",
        &format!("Uploaded \"{}\"", relative_str),
        Some(&relative_str),
        Some(size as i64),
        Some(source_id),
    );

    FileOutcome::Uploaded
}

/// Cheap, non-cryptographic string hash used only to make each file's
/// `transfer_id` distinct for progress-event correlation — collisions here
/// have no correctness impact, they'd just merge two files' progress ticks.
fn simple_hash(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

async fn restore_backup_locked(
    app: &AppHandle,
    source_id: &str,
    restore_path: &str,
) -> Result<RestoreRunSummary, String> {
    let settings = load_settings(app);
    let source = settings
        .sources
        .iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| "Unknown backup source".to_string())?;
    let channel_id = source
        .channel_id
        .ok_or_else(|| "This folder has never been backed up".to_string())?;

    let restore_root = PathBuf::from(restore_path);
    tokio::fs::create_dir_all(&restore_root)
        .await
        .map_err(|error| format!("Could not create restore destination: {}", error))?;

    let files = crate::commands::fs::cmd_get_files(
        Some(channel_id),
        app.clone(),
        app.state::<TelegramState>(),
        app.state::<DbConnection>(),
        app.state::<CryptoState>(),
    )
    .await?;

    let files_total = files.len() as u32;
    let files_done = Arc::new(AtomicU32::new(0));
    {
        let backup_state = app.state::<BackupState>();
        let mut current = backup_state.current.lock().unwrap();
        *current = Some((source_id.to_string(), 0, files_total));
    }

    let outcomes: Vec<Result<(), String>> = stream::iter(files)
        .map(|file| {
            let app = app.clone();
            let restore_root = restore_root.clone();
            let source_id = source_id.to_string();
            let files_done = files_done.clone();
            async move {
                let cancelled = app.state::<BackupState>().cancel_requested.load(Ordering::SeqCst);
                let outcome = if cancelled {
                    Err("__skipped__".to_string())
                } else {
                    restore_one_file(&app, channel_id, &restore_root, &file).await
                };

                let done = files_done.fetch_add(1, Ordering::SeqCst) + 1;
                {
                    let backup_state = app.state::<BackupState>();
        let mut current = backup_state.current.lock().unwrap();
                    *current = Some((source_id.clone(), done, files_total));
                }
                let _ = app.emit(
                    "backup-progress",
                    BackupProgressPayload {
                        phase: "restore",
                        source_id,
                        files_done: done,
                        files_total,
                        current_file: Some(file.name.clone()),
                    },
                );

                outcome
            }
        })
        .buffer_unordered(TRANSFER_CONCURRENCY)
        .collect()
        .await;

    let mut summary = RestoreRunSummary::default();
    for outcome in outcomes {
        match outcome {
            Ok(()) => summary.restored += 1,
            Err(error) if error == "__skipped__" => summary.skipped += 1,
            Err(error) => {
                summary.failed += 1;
                summary.errors.push(error);
            }
        }
    }
    Ok(summary)
}

/// Rebuilds a Telegram-carried file name (which legitimately contains `/` to
/// preserve backup subdirectory structure, e.g. `"subdir/file.txt"`) into a
/// path confined to `root`. Rejects anything that could escape it: absolute
/// paths, drive letters, `..`/`.` segments, and empty segments. Returns
/// `None` if the name can't be made safe.
///
/// `file.name` is not trustworthy input — it comes from a live message in
/// the backup channel, which (given channel access) could carry an
/// attacker-crafted name like `"..\\..\\AppData\\Roaming\\Startup\\evil.exe"`.
/// Restoring must never let that escape the chosen restore folder.
fn sanitize_restore_path(root: &Path, name: &str) -> Option<PathBuf> {
    let mut target = root.to_path_buf();
    let mut had_component = false;
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        // A bare drive letter or similar (`C:`) as a segment indicates an
        // absolute Windows path smuggled in via a name with no separators
        // Rust would otherwise treat as relative.
        if part.contains(':') {
            return None;
        }
        target.push(part);
        had_component = true;
    }
    if !had_component {
        return None;
    }
    Some(target)
}

async fn restore_one_file(
    app: &AppHandle,
    channel_id: i64,
    restore_root: &Path,
    file: &crate::models::FileMetadata,
) -> Result<(), String> {
    if file.name.is_empty() {
        return Err("Skipped a file with an empty name".to_string());
    }
    let target = sanitize_restore_path(restore_root, &file.name)
        .ok_or_else(|| format!("{}: unsafe file name, skipped", file.name))?;
    let Some(parent) = target.parent() else {
        return Err(format!("{}: could not resolve a parent directory", file.name));
    };
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("{}: {}", file.name, error))?;

    // Defense in depth: even after sanitizing, confirm the directory we're
    // about to write into actually resolves inside restore_root once the
    // filesystem has normalized it (symlinks, etc.) — canonicalize needs the
    // path to exist, which is why this runs after create_dir_all.
    let (canonical_parent, canonical_root) = tokio::join!(
        tokio::fs::canonicalize(parent),
        tokio::fs::canonicalize(restore_root)
    );
    match (canonical_parent, canonical_root) {
        (Ok(canonical_parent), Ok(canonical_root)) if canonical_parent.starts_with(&canonical_root) => {}
        _ => {
            return Err(format!(
                "{}: restore path resolved outside the destination folder, skipped",
                file.name
            ))
        }
    }

    // Telegram carries no local mtime, so collision detection here can only
    // compare size — good enough to skip an unmodified re-restore without
    // needlessly re-downloading, while still overwriting anything that looks
    // different.
    if let Ok(existing) = tokio::fs::metadata(&target).await {
        if existing.len() == file.size {
            return Err("__skipped__".to_string());
        }
    }

    let request = crate::commands::fs::DownloadFileRequest {
        message_id: file.id as i32,
        save_path: target.to_string_lossy().to_string(),
        folder_id: Some(channel_id),
        transfer_id: Some(format!("restore-{}-{}", channel_id, file.id)),
        prompt_token: None,
    };

    crate::commands::fs::cmd_download_file(
        request,
        app.clone(),
        app.state::<TelegramState>(),
        app.state::<Arc<BandwidthManager>>(),
        app.state::<Arc<NetworkConfig>>(),
        app.state::<CryptoState>(),
        app.state::<DbConnection>(),
    )
    .await
    .map(|_| ())
    .map_err(|error| format!("{}: {}", file.name, error))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cmd_get_backup_settings(app: AppHandle) -> Result<BackupSettingsFile, String> {
    Ok(load_settings(&app))
}

#[tauri::command]
pub async fn cmd_add_backup_source(
    local_path: String,
    // Existing Telegram folder to back up into, if the user picked one in
    // the destination step; `None` keeps the original behavior of lazily
    // creating a new dedicated "[TD-Backup]" channel on first run.
    channel_id: Option<i64>,
    excluded_paths: Option<Vec<String>>,
    app: AppHandle,
) -> Result<BackupSettingsFile, String> {
    let path = Path::new(&local_path);
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("'{}' is not accessible: {}", local_path, error))?;
    if !metadata.is_dir() {
        return Err(format!("'{}' is not a folder", local_path));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve '{}': {}", local_path, error))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    let mut settings = load_settings(&app);
    if settings
        .sources
        .iter()
        .any(|source| source.local_path == canonical_str)
    {
        return Err("This folder is already protected".to_string());
    }

    let display_name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| canonical_str.clone());

    settings.sources.push(BackupSourceFolder {
        id: generate_source_id(),
        local_path: canonical_str,
        display_name,
        channel_id,
        enabled: true,
        last_run_at: None,
        last_run_status: None,
        last_error: None,
        excluded_paths: excluded_paths.unwrap_or_default(),
    });
    save_settings(&app, &settings)?;
    Ok(settings)
}

/// Updates which paths (relative to the source's local folder) are skipped
/// entirely during backup, for a source that's already been added.
#[tauri::command]
pub async fn cmd_set_backup_exclusions(
    source_id: String,
    excluded_paths: Vec<String>,
    app: AppHandle,
) -> Result<BackupSettingsFile, String> {
    let mut settings = load_settings(&app);
    let source = settings
        .sources
        .iter_mut()
        .find(|source| source.id == source_id)
        .ok_or_else(|| "Backup source not found".to_string())?;
    source.excluded_paths = excluded_paths;
    save_settings(&app, &settings)?;
    Ok(settings)
}

/// Lists the immediate contents of a local directory (name + is_dir) for the
/// exclude-picker UI — one level at a time, the frontend recurses by calling
/// this again as the user expands a subfolder, rather than walking the
/// entire tree up front (which could be huge/slow for a large source folder).
#[derive(Debug, Serialize, Clone)]
pub struct LocalDirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn cmd_list_local_dir_entries(path: String) -> Result<Vec<LocalDirEntry>, String> {
    let mut entries = tokio::fs::read_dir(&path)
        .await
        .map_err(|error| format!("Could not read '{}': {}", path, error))?;
    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|error| error.to_string())? {
        let file_type = entry.file_type().await.map_err(|error| error.to_string())?;
        result.push(LocalDirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
        });
    }
    result.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(result)
}

#[tauri::command]
pub async fn cmd_remove_backup_source(
    source_id: String,
    app: AppHandle,
    db_pool: State<'_, DbConnection>,
) -> Result<BackupSettingsFile, String> {
    let mut settings = load_settings(&app);
    settings.sources.retain(|source| source.id != source_id);
    save_settings(&app, &settings)?;

    if let Ok(conn) = db_pool.lock() {
        let _ = ledger_remove_source(&conn, &source_id);
    }
    Ok(settings)
}

#[tauri::command]
pub async fn cmd_set_backup_source_enabled(
    source_id: String,
    enabled: bool,
    app: AppHandle,
) -> Result<BackupSettingsFile, String> {
    let mut settings = load_settings(&app);
    let source = settings
        .sources
        .iter_mut()
        .find(|source| source.id == source_id)
        .ok_or_else(|| "Unknown backup source".to_string())?;
    source.enabled = enabled;
    save_settings(&app, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub async fn cmd_update_backup_schedule(
    enabled: bool,
    schedule_hour: u8,
    schedule_minute: u8,
    app: AppHandle,
) -> Result<BackupSettingsFile, String> {
    if schedule_hour > 23 {
        return Err("Hour must be between 0 and 23".to_string());
    }
    if schedule_minute > 59 {
        return Err("Minute must be between 0 and 59".to_string());
    }

    let mut settings = load_settings(&app);
    settings.enabled = enabled;
    settings.schedule_hour = schedule_hour;
    settings.schedule_minute = schedule_minute;
    save_settings(&app, &settings)?;

    restart_backup_scheduler(&app);
    Ok(settings)
}

#[tauri::command]
pub async fn cmd_backup_now(app: AppHandle) -> Result<BackupRunSummary, String> {
    run_backup(&app, None, false).await
}

// ---------------------------------------------------------------------------
// "Backup All" — the OneDrive-style one-click action: protects the standard
// Desktop/Documents/Pictures folders. Calculating first (rather than just
// adding + running immediately) exists because these can be large and the
// user may not realize how much is in them — the calculate step lets them
// see the real size and back out before anything actually uploads.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct StandardFoldersResponse {
    pub desktop: Option<String>,
    pub documents: Option<String>,
    pub pictures: Option<String>,
}

#[tauri::command]
pub async fn cmd_get_standard_folders(app: AppHandle) -> Result<StandardFoldersResponse, String> {
    let resolver = app.path();
    Ok(StandardFoldersResponse {
        desktop: resolver.desktop_dir().ok().map(|p| p.to_string_lossy().to_string()),
        documents: resolver.document_dir().ok().map(|p| p.to_string_lossy().to_string()),
        pictures: resolver.picture_dir().ok().map(|p| p.to_string_lossy().to_string()),
    })
}

#[derive(Debug, Serialize, Clone)]
pub struct BackupAllCalculation {
    pub paths: Vec<String>,
    pub total_bytes: u64,
    pub total_files: u32,
    pub notification_id: String,
}

/// Walks the standard folders (whichever of Desktop/Documents/Pictures
/// actually resolve and exist on this system — not every platform/profile
/// has all three) and sums their size, then raises a notification requiring
/// approval before anything is actually added/uploaded.
#[tauri::command]
pub async fn cmd_calculate_backup_all(
    app: AppHandle,
    db_pool: State<'_, DbConnection>,
) -> Result<BackupAllCalculation, String> {
    let standard = {
        let resolver = app.path();
        [resolver.desktop_dir().ok(), resolver.document_dir().ok(), resolver.picture_dir().ok()]
    };

    let mut paths = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut total_files: u32 = 0;

    for candidate in standard.into_iter().flatten() {
        if !candidate.is_dir() {
            continue;
        }
        let path_str = candidate.to_string_lossy().to_string();
        for entry in walkdir::WalkDir::new(&candidate)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
        {
            if let Ok(metadata) = entry.metadata() {
                total_bytes += metadata.len();
                total_files += 1;
            }
        }
        paths.push(path_str);
    }

    if paths.is_empty() {
        return Err("Could not locate Desktop, Documents, or Pictures on this system.".to_string());
    }

    let payload = serde_json::to_string(&crate::commands::notifications::BackupAllPayload {
        paths: paths.clone(),
        total_bytes,
        total_files,
    })
    .map_err(|error| error.to_string())?;

    let message = format!(
        "Ready to back up {} files ({}) from Desktop, Documents, and Pictures. Approve to start.",
        total_files,
        format_bytes_human(total_bytes),
    );
    let notification_id = crate::commands::notifications::push_notification(
        &db_pool,
        "backup_all_calculated",
        "Backup All — ready to start",
        &message,
        true,
        Some(&payload),
    )?;

    Ok(BackupAllCalculation { paths, total_bytes, total_files, notification_id })
}

fn format_bytes_human(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit_index = 0;
    while size >= 1024.0 && unit_index < UNITS.len() - 1 {
        size /= 1024.0;
        unit_index += 1;
    }
    format!("{:.1} {}", size, UNITS[unit_index])
}

/// Called when the user approves the "Backup All" notification — registers
/// whichever of the calculated paths aren't already protected, then runs a
/// backup immediately rather than waiting for the next scheduled time.
pub async fn run_backup_all_approved(app: &AppHandle, paths: Vec<String>) -> Result<(), String> {
    let mut settings = load_settings(app);
    for path in paths {
        let canonical = match std::path::Path::new(&path).canonicalize() {
            Ok(c) => c.to_string_lossy().to_string(),
            Err(_) => continue, // No longer accessible — skip rather than fail the whole batch.
        };
        if settings.sources.iter().any(|source| source.local_path == canonical) {
            continue; // Already protected — approving twice must not duplicate it.
        }
        let display_name = std::path::Path::new(&canonical)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| canonical.clone());
        settings.sources.push(BackupSourceFolder {
            id: generate_source_id(),
            local_path: canonical,
            display_name,
            channel_id: None,
            enabled: true,
            last_run_at: None,
            last_run_status: None,
            last_error: None,
            excluded_paths: Vec::new(),
        });
    }
    save_settings(app, &settings)?;

    run_backup(app, None, false).await?;
    Ok(())
}

/// Requests that the in-progress backup/restore run stop as soon as it
/// safely can — files already uploading finish normally, no new ones start.
/// A no-op (not an error) if nothing is currently running.
#[tauri::command]
pub async fn cmd_cancel_backup(app: AppHandle) -> Result<(), String> {
    app.state::<BackupState>()
        .cancel_requested
        .store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn cmd_restore_backup(
    source_id: String,
    restore_path: String,
    app: AppHandle,
) -> Result<RestoreRunSummary, String> {
    let backup_state = app.state::<BackupState>();
    if backup_state.running.swap(true, Ordering::SeqCst) {
        return Err("A backup or restore is already in progress".to_string());
    }
    backup_state.cancel_requested.store(false, Ordering::SeqCst);
    let result = restore_backup_locked(&app, &source_id, &restore_path).await;
    backup_state.running.store(false, Ordering::SeqCst);
    backup_state.cancel_requested.store(false, Ordering::SeqCst);
    *backup_state.current.lock().unwrap() = None;
    result
}

#[tauri::command]
pub async fn cmd_get_backup_status(app: AppHandle) -> Result<BackupStatus, String> {
    let backup_state = app.state::<BackupState>();
    let running = backup_state.running.load(Ordering::SeqCst);
    let (current_source_id, current_files_done, current_files_total) = backup_state
        .current
        .lock()
        .unwrap()
        .clone()
        .map(|(id, done, total)| (Some(id), done, total))
        .unwrap_or((None, 0, 0));

    let settings = load_settings(&app);
    let next_scheduled_run_at = if settings.enabled && settings.sources.iter().any(|source| source.enabled) {
        Some(next_run_timestamp(settings.schedule_hour, settings.schedule_minute))
    } else {
        None
    };

    Ok(BackupStatus {
        running,
        current_source_id,
        current_files_done,
        current_files_total,
        next_scheduled_run_at,
        settings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_disabled_at_noon() {
        let settings = BackupSettingsFile::default();
        assert!(!settings.enabled);
        assert_eq!(settings.schedule_hour, 12);
        assert_eq!(settings.schedule_minute, 0);
        assert!(settings.sources.is_empty());
    }

    #[test]
    fn next_run_timestamp_is_in_the_future() {
        let now = chrono::Utc::now().timestamp();
        let next = next_run_timestamp(12, 0);
        assert!(next > now);
        // Should never be more than 24h + a few seconds away.
        assert!(next - now <= 86_400 + 5);
    }

    #[test]
    fn simple_hash_is_deterministic() {
        assert_eq!(simple_hash("Docs/report.pdf"), simple_hash("Docs/report.pdf"));
        assert_ne!(simple_hash("Docs/report.pdf"), simple_hash("Docs/report2.pdf"));
    }
}

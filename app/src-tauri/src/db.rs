use tauri::{AppHandle, Manager};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type DbConnection = Arc<Mutex<sqlite::Connection>>;

/// Maximum number of retry attempts for database initialization
const MAX_DB_INIT_RETRIES: u32 = 5;

pub fn init_db(app: &AppHandle) -> Result<DbConnection, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db_path = dir.join("shares.db");
    
    // Retry opening the database with exponential backoff.
    // SQLite may report "database is locked" if another process or a stale
    // wal/shm journal hasn't been cleaned up yet (e.g., after a crash).
    let conn = {
        let mut last_err = String::new();
        let mut opened = None;
        for attempt in 0..MAX_DB_INIT_RETRIES {
            match sqlite::open(&db_path) {
                Ok(c) => {
                    opened = Some(c);
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    if attempt < MAX_DB_INIT_RETRIES - 1 {
                        let wait_ms = 100 * 2u64.pow(attempt);
                        log::warn!(
                            "Failed to open SQLite database (attempt {}/{}): {}. Retrying in {}ms...",
                            attempt + 1, MAX_DB_INIT_RETRIES, last_err, wait_ms
                        );
                        std::thread::sleep(Duration::from_millis(wait_ms));
                    }
                }
            }
        }
        opened.ok_or_else(|| {
            format!(
                "Failed to open SQLite database after {} attempts: {}",
                MAX_DB_INIT_RETRIES, last_err
            )
        })?
    };
    
    // Run migration (also with retry for locked-database scenarios)
    {
        let mut last_err = String::new();
        for attempt in 0..MAX_DB_INIT_RETRIES {
            match conn.execute(
                "CREATE TABLE IF NOT EXISTS shared_links (
                    id TEXT PRIMARY KEY,
                    folder_id INTEGER,
                    message_id INTEGER NOT NULL,
                    file_name TEXT NOT NULL,
                    file_size INTEGER NOT NULL DEFAULT 0,
                    password_hash TEXT,
                    password_salt TEXT,
                    expires_at INTEGER,
                    revoked INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS groups (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    color_hex TEXT DEFAULT '#3B82F6',
                    display_order INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS folder_metadata (
                    channel_id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    username TEXT,
                    is_public INTEGER NOT NULL DEFAULT 0,
                    display_order INTEGER NOT NULL DEFAULT 0,
                    group_id INTEGER,
                    FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE SET NULL
                );"
            ) {
                Ok(_) => {
                    last_err.clear();
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    if attempt < MAX_DB_INIT_RETRIES - 1 {
                        let wait_ms = 100 * 2u64.pow(attempt);
                        log::warn!(
                            "Failed to run SQLite migration (attempt {}/{}): {}. Retrying in {}ms...",
                            attempt + 1, MAX_DB_INIT_RETRIES, last_err, wait_ms
                        );
                        std::thread::sleep(Duration::from_millis(wait_ms));
                    }
                }
            }
        }
        if !last_err.is_empty() {
            return Err(format!(
                "Failed to run SQLite migration after {} attempts: {}",
                MAX_DB_INIT_RETRIES, last_err
            ));
        }
    }

    // Encryption tables migration. Run the complete migration in one explicit
    // transaction so a crash cannot leave a partially upgraded registry.
    {
        let mut last_err = String::new();
        for attempt in 0..MAX_DB_INIT_RETRIES {
            match run_encryption_migration(&conn) {
                Ok(_) => {
                    last_err.clear();
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    if attempt < MAX_DB_INIT_RETRIES - 1 {
                        let wait_ms = 100 * 2u64.pow(attempt);
                        log::warn!(
                            "Failed to run encryption migration (attempt {}/{}): {}. Retrying in {}ms...",
                            attempt + 1, MAX_DB_INIT_RETRIES, last_err, wait_ms
                        );
                        std::thread::sleep(Duration::from_millis(wait_ms));
                    }
                }
            }
        }
        if !last_err.is_empty() {
            return Err(format!(
                "Failed to run encryption migration after {} attempts: {}",
                MAX_DB_INIT_RETRIES, last_err
            ));
        }
    }
    
    // Backup feature migration (backup_file_state ledger). Same retry-wrapped,
    // transactional pattern as the encryption migration above.
    {
        let mut last_err = String::new();
        for attempt in 0..MAX_DB_INIT_RETRIES {
            match run_backup_migration(&conn) {
                Ok(_) => {
                    last_err.clear();
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    if attempt < MAX_DB_INIT_RETRIES - 1 {
                        let wait_ms = 100 * 2u64.pow(attempt);
                        log::warn!(
                            "Failed to run backup migration (attempt {}/{}): {}. Retrying in {}ms...",
                            attempt + 1, MAX_DB_INIT_RETRIES, last_err, wait_ms
                        );
                        std::thread::sleep(Duration::from_millis(wait_ms));
                    }
                }
            }
        }
        if !last_err.is_empty() {
            return Err(format!(
                "Failed to run backup migration after {} attempts: {}",
                MAX_DB_INIT_RETRIES, last_err
            ));
        }
    }

    // Always-on relay columns on the single-file `shared_links` table —
    // additive only, existing rows default to `always_on = 0`.
    {
        let mut last_err = String::new();
        for attempt in 0..MAX_DB_INIT_RETRIES {
            match run_shared_links_relay_migration(&conn) {
                Ok(_) => {
                    last_err.clear();
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    if attempt < MAX_DB_INIT_RETRIES - 1 {
                        let wait_ms = 100 * 2u64.pow(attempt);
                        std::thread::sleep(Duration::from_millis(wait_ms));
                    }
                }
            }
        }
        if !last_err.is_empty() {
            return Err(format!(
                "Failed to run shared_links relay migration after {} attempts: {}",
                MAX_DB_INIT_RETRIES, last_err
            ));
        }
    }

    // Folder-shares (permissioned Temp Link) migration. Additive, parallel to
    // the existing single-file `shared_links` table — never touches it.
    {
        let mut last_err = String::new();
        for attempt in 0..MAX_DB_INIT_RETRIES {
            match run_folder_shares_migration(&conn) {
                Ok(_) => {
                    last_err.clear();
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    if attempt < MAX_DB_INIT_RETRIES - 1 {
                        let wait_ms = 100 * 2u64.pow(attempt);
                        log::warn!(
                            "Failed to run folder_shares migration (attempt {}/{}): {}. Retrying in {}ms...",
                            attempt + 1, MAX_DB_INIT_RETRIES, last_err, wait_ms
                        );
                        std::thread::sleep(Duration::from_millis(wait_ms));
                    }
                }
            }
        }
        if !last_err.is_empty() {
            return Err(format!(
                "Failed to run folder_shares migration after {} attempts: {}",
                MAX_DB_INIT_RETRIES, last_err
            ));
        }
    }

    // Notifications (bell dropdown) + audit log (itemized backup/upload
    // history). Additive, independent of every other table above.
    {
        let mut last_err = String::new();
        for attempt in 0..MAX_DB_INIT_RETRIES {
            match run_notifications_migration(&conn) {
                Ok(_) => {
                    last_err.clear();
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    if attempt < MAX_DB_INIT_RETRIES - 1 {
                        let wait_ms = 100 * 2u64.pow(attempt);
                        log::warn!(
                            "Failed to run notifications migration (attempt {}/{}): {}. Retrying in {}ms...",
                            attempt + 1, MAX_DB_INIT_RETRIES, last_err, wait_ms
                        );
                        std::thread::sleep(Duration::from_millis(wait_ms));
                    }
                }
            }
        }
        if !last_err.is_empty() {
            return Err(format!(
                "Failed to run notifications migration after {} attempts: {}",
                MAX_DB_INIT_RETRIES, last_err
            ));
        }
    }

    log::info!("SQLite database initialized successfully using sqlite crate.");
    Ok(Arc::new(Mutex::new(conn)))
}

fn run_notifications_migration(conn: &sqlite::Connection) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE TRANSACTION")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                read INTEGER NOT NULL DEFAULT 0,
                requires_action INTEGER NOT NULL DEFAULT 0,
                action_resolved INTEGER NOT NULL DEFAULT 0,
                action_payload TEXT
            );
            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                detail TEXT NOT NULL,
                file_name TEXT,
                bytes INTEGER,
                source_id TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);",
        )
        .map_err(|error| error.to_string())?;

        conn.execute(format!(
            "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (7, {})",
            chrono::Utc::now().timestamp()
        ))
        .map_err(|error| error.to_string())?;
        Ok(())
    })();

    match result {
        Ok(()) => conn.execute("COMMIT").map_err(|error| error.to_string()),
        Err(error) => {
            let _ = conn.execute("ROLLBACK");
            Err(error)
        }
    }
}

fn encryption_column_exists(
    conn: &sqlite::Connection,
    column_name: &str,
) -> Result<bool, String> {
    let mut statement = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('encrypted_files') WHERE name = ?")
        .map_err(|error| error.to_string())?;
    statement
        .bind((1, column_name))
        .map_err(|error| error.to_string())?;
    if let sqlite::State::Row = statement.next().map_err(|error| error.to_string())? {
        return statement
            .read::<i64, _>(0)
            .map(|count| count > 0)
            .map_err(|error| error.to_string());
    }
    Ok(false)
}

fn run_encryption_migration(conn: &sqlite::Connection) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE TRANSACTION")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS encrypted_files (
                folder_key TEXT NOT NULL,
                message_id INTEGER NOT NULL,
                file_uuid BLOB NOT NULL,
                envelope_version INTEGER NOT NULL,
                cipher_suite INTEGER NOT NULL,
                ciphertext_size INTEGER NOT NULL,
                plaintext_size INTEGER,
                remote_name TEXT NOT NULL,
                key_profile_id TEXT,
                protection_mode TEXT NOT NULL DEFAULT 'vault',
                metadata_protected INTEGER NOT NULL DEFAULT 0,
                header_blob BLOB,
                header_sha256 BLOB,
                record_state TEXT NOT NULL DEFAULT 'active',
                reconciliation_state TEXT NOT NULL DEFAULT 'ok',
                created_at INTEGER NOT NULL,
                last_verified_at INTEGER,
                PRIMARY KEY(folder_key, message_id)
            );
            CREATE TABLE IF NOT EXISTS encryption_profiles (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                kind TEXT NOT NULL,
                vault_locator TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );",
        )
        .map_err(|error| error.to_string())?;

        let additions = [
            ("plaintext_size", "INTEGER"),
            ("protection_mode", "TEXT NOT NULL DEFAULT 'vault'"),
            ("metadata_protected", "INTEGER NOT NULL DEFAULT 0"),
            ("reconciliation_state", "TEXT NOT NULL DEFAULT 'ok'"),
        ];
        for (name, declaration) in additions {
            if !encryption_column_exists(conn, name)? {
                conn.execute(format!(
                    "ALTER TABLE encrypted_files ADD COLUMN {name} {declaration}"
                ))
                .map_err(|error| error.to_string())?;
            }
        }
        conn.execute(format!(
            "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (3, {})",
            chrono::Utc::now().timestamp()
        ))
        .map_err(|error| error.to_string())?;
        Ok(())
    })();

    match result {
        Ok(()) => conn
            .execute("COMMIT")
            .map_err(|error| error.to_string()),
        Err(error) => {
            let _ = conn.execute("ROLLBACK");
            Err(error)
        }
    }
}

/// Ledger of files already uploaded by the Backup feature, keyed by
/// (source folder, relative path) so re-running a backup can skip files
/// whose size/mtime haven't changed since the last successful upload.
fn run_backup_migration(conn: &sqlite::Connection) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE TRANSACTION")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS backup_file_state (
                source_id TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                message_id INTEGER NOT NULL,
                size INTEGER NOT NULL,
                mtime INTEGER NOT NULL,
                uploaded_at INTEGER NOT NULL,
                PRIMARY KEY(source_id, relative_path)
            );",
        )
        .map_err(|error| error.to_string())?;

        conn.execute(format!(
            "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (4, {})",
            chrono::Utc::now().timestamp()
        ))
        .map_err(|error| error.to_string())?;
        Ok(())
    })();

    match result {
        Ok(()) => conn.execute("COMMIT").map_err(|error| error.to_string()),
        Err(error) => {
            let _ = conn.execute("ROLLBACK");
            Err(error)
        }
    }
}

/// Permissioned, folder-scoped share links ("Temp Link Generator"). Kept as
/// a table parallel to `shared_links` (which stays file-level, download-only,
/// unchanged) rather than extending it, since `shared_links.message_id` is
/// NOT NULL and SQLite can't relax that via ALTER TABLE without a full
/// table rebuild.
fn table_column_exists(
    conn: &sqlite::Connection,
    table_name: &str,
    column_name: &str,
) -> Result<bool, String> {
    let mut statement = conn
        .prepare(format!(
            "SELECT COUNT(*) FROM pragma_table_info('{}') WHERE name = ?",
            table_name
        ))
        .map_err(|error| error.to_string())?;
    statement
        .bind((1, column_name))
        .map_err(|error| error.to_string())?;
    if let sqlite::State::Row = statement.next().map_err(|error| error.to_string())? {
        return statement
            .read::<i64, _>(0)
            .map(|count| count > 0)
            .map_err(|error| error.to_string());
    }
    Ok(false)
}

fn run_shared_links_relay_migration(conn: &sqlite::Connection) -> Result<(), String> {
    if !table_column_exists(conn, "shared_links", "always_on")? {
        conn.execute("ALTER TABLE shared_links ADD COLUMN always_on INTEGER NOT NULL DEFAULT 0")
            .map_err(|error| error.to_string())?;
    }
    if !table_column_exists(conn, "shared_links", "usage_limit")? {
        conn.execute("ALTER TABLE shared_links ADD COLUMN usage_limit INTEGER")
            .map_err(|error| error.to_string())?;
    }
    if !table_column_exists(conn, "shared_links", "usage_count")? {
        conn.execute("ALTER TABLE shared_links ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn folder_shares_column_exists(conn: &sqlite::Connection, column_name: &str) -> Result<bool, String> {
    let mut statement = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('folder_shares') WHERE name = ?")
        .map_err(|error| error.to_string())?;
    statement
        .bind((1, column_name))
        .map_err(|error| error.to_string())?;
    if let sqlite::State::Row = statement.next().map_err(|error| error.to_string())? {
        return statement
            .read::<i64, _>(0)
            .map(|count| count > 0)
            .map_err(|error| error.to_string());
    }
    Ok(false)
}

fn run_folder_shares_migration(conn: &sqlite::Connection) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE TRANSACTION")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS folder_shares (
                id TEXT PRIMARY KEY,
                folder_id INTEGER,
                folder_name TEXT NOT NULL,
                permissions INTEGER NOT NULL DEFAULT 0,
                password_hash TEXT,
                username TEXT,
                expires_at INTEGER,
                revoked INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );",
        )
        .map_err(|error| error.to_string())?;

        // Non-destructive column add for installs that already ran this
        // migration before the `username` field existed.
        if !folder_shares_column_exists(conn, "username")? {
            conn.execute("ALTER TABLE folder_shares ADD COLUMN username TEXT")
                .map_err(|error| error.to_string())?;
        }

        conn.execute(format!(
            "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (5, {})",
            chrono::Utc::now().timestamp()
        ))
        .map_err(|error| error.to_string())?;
        conn.execute(format!(
            "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (6, {})",
            chrono::Utc::now().timestamp()
        ))
        .map_err(|error| error.to_string())?;
        Ok(())
    })();

    match result {
        Ok(()) => conn.execute("COMMIT").map_err(|error| error.to_string()),
        Err(error) => {
            let _ = conn.execute("ROLLBACK");
            Err(error)
        }
    }
}

use std::sync::Arc;
use std::collections::{HashMap, HashSet};
use tokio::sync::Mutex;
use grammers_client::{Client};
use grammers_client::types::{LoginToken, PasswordToken, Peer};

/// Tracks the lifecycle of the Telegram connection
/// 
/// IMPORTANT: The `runner_shutdown` field is critical for preventing stack overflow.
/// When reconnecting, we MUST shutdown the old runner before spawning a new one.
/// Without this, runner tasks accumulate and exhaust the thread stack.
#[derive(Clone)]
pub struct TelegramState {
    pub client: Arc<Mutex<Option<Client>>>,
    pub login_token: Arc<Mutex<Option<LoginToken>>>,
    pub password_token: Arc<Mutex<Option<PasswordToken>>>,
    pub api_id: Arc<Mutex<Option<i32>>>,
    /// Send to this channel to request runner shutdown.
    /// Uses std::sync::Mutex (not tokio) so it can be locked from synchronous
    /// contexts like the RunEvent::Exit handler.
    pub runner_shutdown: Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    /// Counter for debugging runner lifecycle
    pub runner_count: Arc<std::sync::atomic::AtomicU32>,
    /// Cache of folder_id → Peer to avoid O(N) dialog scanning on every operation.
    /// Populated lazily on first resolve_peer call, eagerly during cmd_scan_folders.
    /// Cleared on logout.
    pub peer_cache: Arc<tokio::sync::RwLock<HashMap<i64, Peer>>>,
    /// Set of transfer IDs that have been cancelled. Checked cooperatively
    /// in upload/download chunk loops. Cleared on logout.
    pub cancelled_transfers: Arc<tokio::sync::RwLock<HashSet<String>>>,
    /// Guards the one-shot remote-jobs check (see `remote_catalog.rs`) so it
    /// runs exactly once per launch regardless of which of the several
    /// `ensure_client_initialized` call sites first establishes the
    /// connection — not a continuous poll, just a single flag flip.
    pub remote_jobs_checked: Arc<std::sync::atomic::AtomicBool>,
    /// True while a remote-jobs drain is in flight. Unlike
    /// `remote_jobs_checked` (a one-shot for the launch check), this is a
    /// re-entrancy guard: the window-focus trigger can fire repeatedly and in
    /// quick succession, and `process_pending_jobs_once` is not re-entrant —
    /// two overlapping runs would execute the same pending job twice.
    pub remote_jobs_running: Arc<std::sync::atomic::AtomicBool>,
}

pub mod auth;
pub mod fs;
pub mod preview;
pub mod utils;
pub mod network;
pub mod streaming;
pub mod api_settings;
pub mod webdav_settings;
pub mod settings;
pub mod sharing;
pub mod video_metadata;
pub mod archive;
pub mod folder_groups;
pub mod backup;
pub mod google_auth;
pub mod smtp_settings;
pub mod app_lock;
pub mod relay;
pub mod totp;
pub mod notifications;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod autostart;
pub mod share_domain;

pub use auth::*;
pub use fs::*;
pub use preview::*;
pub use utils::*;
pub use network::*;
pub use streaming::*;
pub use api_settings::*;
pub use settings::*;
pub use sharing::*;
pub use video_metadata::*;
pub use archive::*;
pub use folder_groups::*;

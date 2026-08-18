//! Best-effort public HTTPS tunnel for the "Temp Link" share feature.
//!
//! The streaming server binds to `127.0.0.1` only (see `server.rs`), so share
//! links only ever worked on this same machine. To make them reachable from
//! other devices — including over the public internet, not just the LAN —
//! this spawns Cloudflare's free "quick tunnel" (`cloudflared tunnel --url`),
//! which needs no account/signup and gives back a real `https://*.trycloudflare.com`
//! URL that proxies straight to our local server.
//!
//! This exposes the *entire* local server (not just `/s/` and `/d/` share
//! routes) to the public internet for as long as the tunnel is up. That's an
//! intentional tradeoff the user explicitly asked for; every other route the
//! server hosts is expected to already be safe to reach without a session
//! (see server.rs), same as it would be if someone port-forwarded manually.
//!
//! Quick tunnels are meant for exactly this kind of ad hoc use: the URL is
//! randomly generated and changes every time the tunnel restarts (e.g. on
//! app relaunch), and Cloudflare doesn't guarantee uptime SLA for them. If
//! `cloudflared` can't be found or downloaded, sharing silently falls back to
//! the local-only address — nothing breaks, links just won't be reachable
//! from outside this machine.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub struct TunnelState {
    public_url: Arc<StdMutex<Option<String>>>,
    /// A hostname the user configured themselves, pointing at their own named
    /// tunnel (see `commands::share_domain`). Takes precedence over anything a
    /// quick tunnel reports, and is never cleared when cloudflared exits —
    /// it's a setting, not an observation.
    fixed_url: Arc<StdMutex<Option<String>>>,
    /// When the folder-share list was last republished for mobile, used to
    /// rate-limit that publication — see `republish_shares_for_mobile`.
    last_share_publish: Arc<StdMutex<Option<std::time::Instant>>>,
}

impl TunnelState {
    pub fn new() -> Self {
        Self {
            public_url: Arc::new(StdMutex::new(None)),
            fixed_url: Arc::new(StdMutex::new(None)),
            last_share_publish: Arc::new(StdMutex::new(None)),
        }
    }

    /// The public base URL links are built from: the configured hostname if
    /// there is one, otherwise whatever the quick tunnel last reported, or
    /// `None` if neither is available (callers then fall back to loopback).
    pub fn base_url(&self) -> Option<String> {
        if let Some(fixed) = self.fixed_url.lock().ok().and_then(|guard| guard.clone()) {
            return Some(fixed);
        }
        self.public_url.lock().ok().and_then(|guard| guard.clone())
    }

    /// Replaces the configured hostname. `None` restores automatic behaviour.
    pub fn set_fixed_url(&self, url: Option<String>) {
        if let Ok(mut guard) = self.fixed_url.lock() {
            *guard = url;
        }
    }

    pub fn has_fixed_url(&self) -> bool {
        self.fixed_url
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }
}

impl Default for TunnelState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "windows")]
const CLOUDFLARED_DOWNLOAD_URL: &str =
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
#[cfg(target_os = "windows")]
const CLOUDFLARED_FILENAME: &str = "cloudflared.exe";

#[cfg(target_os = "macos")]
const CLOUDFLARED_DOWNLOAD_URL: &str =
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz";
#[cfg(target_os = "macos")]
const CLOUDFLARED_FILENAME: &str = "cloudflared";

#[cfg(all(target_os = "linux", not(target_os = "android")))]
const CLOUDFLARED_DOWNLOAD_URL: &str =
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
#[cfg(all(target_os = "linux", not(target_os = "android")))]
const CLOUDFLARED_FILENAME: &str = "cloudflared";

/// Resolves a usable `cloudflared` binary: reuse one already on PATH, reuse a
/// previously downloaded copy in the app's data dir, or download a fresh one.
async fn resolve_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let mut probe = Command::new("cloudflared");
    probe.arg("--version");
    // Without this the probe flashes a console window on every launch.
    #[cfg(windows)]
    probe.creation_flags(crate::CREATE_NO_WINDOW);
    if let Ok(status) = probe.status().await {
        if status.success() {
            return Ok(PathBuf::from("cloudflared"));
        }
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| error.to_string())?;
    let dest = dir.join(CLOUDFLARED_FILENAME);
    if dest.is_file() {
        return Ok(dest);
    }

    log::info!("Downloading cloudflared for the temp-link public tunnel...");
    let response = reqwest::get(CLOUDFLARED_DOWNLOAD_URL)
        .await
        .map_err(|error| format!("Failed to download cloudflared: {}", error))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download cloudflared: HTTP {}",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read cloudflared download: {}", error))?;
    tokio::fs::write(&dest, &bytes)
        .await
        .map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&dest)
            .await
            .map_err(|error| error.to_string())?
            .permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&dest, perms)
            .await
            .map_err(|error| error.to_string())?;
    }

    Ok(dest)
}

/// Minimum gap between share-list publications triggered by a tunnel change.
/// cloudflared respawns on a 15s backoff, and each publication costs an
/// upload plus a delete in Saved Messages — without this floor, a flapping
/// tunnel would spam the chat straight into a FLOOD_WAIT.
const SHARE_REPUBLISH_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(120);

/// Republishes the folder-share list so mobile learns the tunnel's new public
/// host. Best-effort and rate-limited: skipped entirely when the Telegram
/// client isn't connected yet, or when the last publication was too recent.
async fn republish_shares_for_mobile(app: &AppHandle, state: &Arc<TunnelState>) {
    {
        let mut last = match state.last_share_publish.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if let Some(previous) = *last {
            if previous.elapsed() < SHARE_REPUBLISH_MIN_INTERVAL {
                log::debug!("Skipping share republish — last one was too recent");
                return;
            }
        }
        *last = Some(std::time::Instant::now());
    }

    // Re-read the client from state rather than holding a captured clone:
    // reconnects and logout replace it (and kill the old one's runner), so a
    // cached handle would be permanently dead.
    let telegram_state = app.state::<crate::TelegramState>();
    let client = { telegram_state.client.lock().await.clone() };
    let Some(client) = client else {
        log::debug!("Skipping share republish — Telegram client not connected");
        return;
    };

    if let Err(error) =
        crate::remote_catalog::publish_shares_to_telegram(app, &client, &telegram_state.peer_cache)
            .await
    {
        log::warn!("Could not republish folder shares after tunnel change: {}", error);
    }
}

/// Scans one line of cloudflared's log output for the quick-tunnel URL it
/// prints once the tunnel is live, e.g.
/// `...Visit it at: https://random-words-here.trycloudflare.com ...`.
fn extract_tunnel_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest.find(".trycloudflare.com")? + ".trycloudflare.com".len();
    let candidate = &rest[..end];
    candidate
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '/'))
        .then(|| candidate.to_string())
}

/// Starts the quick tunnel in the background and updates `state` once (and
/// if) a public URL is discovered. Best-effort throughout: any failure just
/// leaves `state.base_url()` at `None`, which callers treat as "tunnel not
/// available, use the local address instead" — but unlike a one-shot attempt,
/// this keeps retrying with a backoff for as long as the app runs, so a
/// transient failure (a momentary network hiccup, DNS blip, cloudflared
/// exiting for no clear reason) self-heals instead of leaving the tunnel
/// permanently unavailable until the next full app restart.
pub fn start(app: AppHandle, local_port: u16, state: Arc<TunnelState>) {
    tauri::async_runtime::spawn(async move {
        // Someone running their own named tunnel already has a stable public
        // hostname, so there is nothing to stand up here. Starting a quick
        // tunnel anyway would burn a second connection to the same port and
        // hand back a random host that changes on every respawn — the exact
        // problem configuring a hostname is meant to solve.
        if state.has_fixed_url() {
            if let Some(url) = state.base_url() {
                log::info!("Temp Links using the configured public address {}", url);
            }
            republish_shares_for_mobile(&app, &state).await;
            return;
        }
        // Binary resolution failing (download blocked, no network at all)
        // is much less likely to change moment-to-moment than a running
        // tunnel process exiting, so it gets a longer backoff — no point
        // hammering a download URL that just failed a second ago.
        const RESOLVE_RETRY_DELAY_SECS: u64 = 300;
        const RESPAWN_RETRY_DELAY_SECS: u64 = 15;

        let binary = loop {
            match resolve_binary(&app).await {
                Ok(path) => break path,
                Err(error) => {
                    log::warn!(
                        "Temp Link public tunnel unavailable, retrying in {}s: {}",
                        RESOLVE_RETRY_DELAY_SECS, error
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(RESOLVE_RETRY_DELAY_SECS)).await;
                }
            }
        };

        loop {
            let mut command = Command::new(&binary);
            command
                .arg("tunnel")
                .arg("--url")
                .arg(format!("http://127.0.0.1:{}", local_port))
                .arg("--no-autoupdate")
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            // The tunnel is a long-lived background helper; the respawn loop
            // below would otherwise stack up a visible console window per
            // restart.
            #[cfg(windows)]
            command.creation_flags(crate::CREATE_NO_WINDOW);
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    log::warn!(
                        "Failed to start cloudflared tunnel, retrying in {}s: {}",
                        RESPAWN_RETRY_DELAY_SECS, error
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(RESPAWN_RETRY_DELAY_SECS)).await;
                    continue;
                }
            };

            let Some(stderr) = child.stderr.take() else {
                log::warn!("cloudflared started but its output could not be captured");
                tokio::time::sleep(std::time::Duration::from_secs(RESPAWN_RETRY_DELAY_SECS)).await;
                continue;
            };

            let mut lines = BufReader::new(stderr).lines();
            let url_state = state.public_url.clone();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("[cloudflared] {}", line);
                if let Some(url) = extract_tunnel_url(&line) {
                    log::info!("Temp Link public tunnel is live: {}", url);
                    let changed = match url_state.lock() {
                        Ok(mut guard) => {
                            let changed = guard.as_deref() != Some(url.as_str());
                            *guard = Some(url);
                            changed
                        }
                        Err(_) => false,
                    };
                    // A quick tunnel gets a brand-new random host every time
                    // it respawns, which invalidates every link mobile is
                    // showing. Republish so the phone picks up the new host
                    // instead of displaying a dead URL.
                    if changed {
                        republish_shares_for_mobile(&app, &state).await;
                    }
                }
            }

            // The process exited (or its stderr closed) — the tunnel is no
            // longer usable; clear the URL so sharing falls back to
            // local-only while we retry standing up a fresh one.
            if let Ok(mut guard) = state.public_url.lock() {
                *guard = None;
            }
            log::warn!(
                "cloudflared tunnel process ended, retrying in {}s",
                RESPAWN_RETRY_DELAY_SECS
            );
            tokio::time::sleep(std::time::Duration::from_secs(RESPAWN_RETRY_DELAY_SECS)).await;
        }
    });
}

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
}

impl TunnelState {
    pub fn new() -> Self {
        Self {
            public_url: Arc::new(StdMutex::new(None)),
        }
    }

    /// The current public base URL (e.g. `https://random-words.trycloudflare.com`),
    /// or `None` if the tunnel hasn't come up yet (or failed to start at all).
    pub fn base_url(&self) -> Option<String> {
        self.public_url.lock().ok().and_then(|guard| guard.clone())
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
    if let Ok(status) = Command::new("cloudflared").arg("--version").status().await {
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
/// available, use the local address instead."
pub fn start(app: AppHandle, local_port: u16, state: Arc<TunnelState>) {
    tauri::async_runtime::spawn(async move {
        let binary = match resolve_binary(&app).await {
            Ok(path) => path,
            Err(error) => {
                log::warn!("Temp Link public tunnel unavailable: {}", error);
                return;
            }
        };

        let mut child = match Command::new(&binary)
            .arg("tunnel")
            .arg("--url")
            .arg(format!("http://127.0.0.1:{}", local_port))
            .arg("--no-autoupdate")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                log::warn!("Failed to start cloudflared tunnel: {}", error);
                return;
            }
        };

        let Some(stderr) = child.stderr.take() else {
            log::warn!("cloudflared started but its output could not be captured");
            return;
        };

        let mut lines = BufReader::new(stderr).lines();
        let url_state = state.public_url.clone();
        while let Ok(Some(line)) = lines.next_line().await {
            log::debug!("[cloudflared] {}", line);
            if let Some(url) = extract_tunnel_url(&line) {
                log::info!("Temp Link public tunnel is live: {}", url);
                if let Ok(mut guard) = url_state.lock() {
                    *guard = Some(url);
                }
            }
        }

        // The process exited (or its stderr closed) — the tunnel is no
        // longer usable; clear the URL so sharing falls back to local-only.
        if let Ok(mut guard) = state.public_url.lock() {
            *guard = None;
        }
        log::warn!("cloudflared tunnel process ended");
    });
}

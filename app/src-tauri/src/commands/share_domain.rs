//! A fixed public base URL for Temp Links, for people running their own
//! Cloudflare Tunnel on a domain they control.
//!
//! By default the app stands up Cloudflare's free "quick tunnel", which needs
//! no account but hands back a random `*.trycloudflare.com` host that changes
//! every time cloudflared respawns — so every link already handed out dies
//! (see `tunnel.rs`). Pointing a named tunnel at a real hostname fixes that,
//! but the app has to be told the hostname: nothing about a named tunnel is
//! discoverable from this side, because cloudflared run from a token gets its
//! routing from Cloudflare's dashboard, not from anything local.
//!
//! Setting one also stops the quick tunnel being started at all — two tunnels
//! to the same port is pure waste, and the random one would otherwise keep
//! overwriting the address links are built from.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ShareDomainSettings {
    /// Normalised origin (`https://drive.example.com`, no trailing slash), or
    /// `None` to use the automatic quick tunnel.
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ShareDomainResponse {
    pub base_url: Option<String>,
    /// The address links are actually being built from right now, which is the
    /// configured host if there is one, otherwise whatever the quick tunnel
    /// reported, otherwise loopback.
    pub effective_base_url: String,
    /// False while the effective address is loopback — links work only on this
    /// machine until a tunnel is up.
    pub public: bool,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("share_domain.json"))
}

pub fn load_settings(app: &AppHandle) -> ShareDomainSettings {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &ShareDomainSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let temp_path = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    std::fs::write(&temp_path, contents).map_err(|error| error.to_string())?;
    // Rename over the old file so a crash mid-write can't leave a truncated
    // settings file behind, matching the other settings modules.
    if std::fs::rename(&temp_path, &path).is_ok() {
        return Ok(());
    }
    std::fs::write(&path, serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?)
        .map_err(|error| error.to_string())?;
    let _ = std::fs::remove_file(&temp_path);
    Ok(())
}

/// Turns whatever the user typed into a bare origin, or explains why it can't
/// be used. Blank input means "clear it and go back to the quick tunnel".
///
/// Kept free of `AppHandle` so it can be unit tested directly.
pub fn normalize_base_url(input: &str) -> Result<Option<String>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    // People paste hostnames far more often than full URLs, and a bare host is
    // unambiguous here, so assume HTTPS rather than rejecting it.
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };

    let parsed = url::Url::parse(&candidate)
        .map_err(|error| format!("That isn't a valid address: {}", error))?;

    match parsed.scheme() {
        "https" => {}
        "http" => {
            return Err(
                "Use https:// — a Cloudflare Tunnel hostname is always served over HTTPS."
                    .to_string(),
            )
        }
        other => return Err(format!("Unsupported address type \"{}://\".", other)),
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "That address has no hostname.".to_string())?
        .to_ascii_lowercase();

    // A loopback or private address would produce links that only work on this
    // machine — which is what the automatic fallback already does, and mobile
    // refuses to show such a link at all.
    let loopback = host == "localhost"
        || host == "::1"
        || host.starts_with("127.")
        || host.starts_with("0.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
        || (host.starts_with("172.")
            && host
                .split('.')
                .nth(1)
                .and_then(|octet| octet.parse::<u8>().ok())
                .is_some_and(|octet| (16..=31).contains(&octet)));
    if loopback {
        return Err(
            "That address only works on your own network. Use the public hostname your tunnel serves."
                .to_string(),
        );
    }

    if !host.contains('.') {
        return Err("That hostname needs a domain, for example drive.example.com.".to_string());
    }

    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Leave off any ? or # part — just the address itself.".to_string());
    }
    // A share link is built as `{base}/s/{token}`, so anything beyond the
    // origin would silently produce a broken path.
    if parsed.path().trim_matches('/') != "" {
        return Err("Leave off the path — just the domain, for example https://drive.example.com.".to_string());
    }

    let mut normalized = format!("https://{}", host);
    if let Some(port) = parsed.port() {
        normalized.push_str(&format!(":{}", port));
    }
    Ok(Some(normalized))
}

#[tauri::command]
pub async fn cmd_get_share_domain(app: AppHandle) -> Result<ShareDomainResponse, String> {
    let settings = load_settings(&app);
    let tunnel_url = app
        .try_state::<std::sync::Arc<crate::tunnel::TunnelState>>()
        .and_then(|state| state.base_url());
    let effective_base_url = tunnel_url
        .clone()
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::STREAM_PORT));
    Ok(ShareDomainResponse {
        base_url: settings.base_url,
        effective_base_url,
        public: tunnel_url.is_some(),
    })
}

#[tauri::command]
pub async fn cmd_set_share_domain(
    app: AppHandle,
    base_url: String,
) -> Result<ShareDomainResponse, String> {
    let normalized = normalize_base_url(&base_url)?;
    save_settings(
        &app,
        &ShareDomainSettings {
            base_url: normalized.clone(),
        },
    )?;

    // Apply immediately so links created before the next restart already use
    // the new address. A quick tunnel started earlier this session keeps
    // running until restart, but is ignored while a fixed address is set.
    if let Some(state) = app.try_state::<std::sync::Arc<crate::tunnel::TunnelState>>() {
        state.set_fixed_url(normalized.clone());
    }
    match &normalized {
        Some(url) => log::info!("Temp Link base URL set to {}", url),
        None => log::info!("Temp Link base URL cleared — using the automatic tunnel"),
    }

    cmd_get_share_domain(app).await
}

#[cfg(test)]
mod tests {
    use super::normalize_base_url;

    #[test]
    fn blank_input_clears_the_setting() {
        assert_eq!(normalize_base_url("").unwrap(), None);
        assert_eq!(normalize_base_url("   ").unwrap(), None);
    }

    #[test]
    fn a_bare_hostname_is_assumed_to_be_https() {
        assert_eq!(
            normalize_base_url("drive.example.com").unwrap(),
            Some("https://drive.example.com".to_string())
        );
    }

    #[test]
    fn trailing_slashes_and_case_are_normalised_away() {
        // These are all the same origin, and must not produce different
        // stored values — links are built by appending to this string.
        for input in [
            "https://Drive.Example.com",
            "https://drive.example.com/",
            "drive.example.com/",
            "  https://DRIVE.example.com  ",
        ] {
            assert_eq!(
                normalize_base_url(input).unwrap(),
                Some("https://drive.example.com".to_string()),
                "input {:?} normalised wrong",
                input
            );
        }
    }

    #[test]
    fn an_explicit_port_is_kept() {
        assert_eq!(
            normalize_base_url("https://drive.example.com:8443").unwrap(),
            Some("https://drive.example.com:8443".to_string())
        );
    }

    #[test]
    fn plain_http_is_refused() {
        assert!(normalize_base_url("http://drive.example.com").is_err());
    }

    #[test]
    fn addresses_that_only_work_locally_are_refused() {
        // Accepting these would hand out links nobody else can open, which is
        // exactly the state the fallback already covers.
        for hostile in [
            "localhost",
            "https://localhost",
            "127.0.0.1",
            "https://127.0.0.1:14201",
            "192.168.1.4",
            "10.0.0.5",
            "172.16.0.9",
            "172.31.255.1",
            "169.254.1.1",
        ] {
            assert!(
                normalize_base_url(hostile).is_err(),
                "should have refused {}",
                hostile
            );
        }
    }

    #[test]
    fn public_addresses_that_merely_look_private_are_still_accepted() {
        // 172.15 and 172.32 are outside the private range, and a hostname
        // starting with "10" is not an address at all.
        for fine in ["172.15.0.1", "172.32.0.1", "10x.example.com"] {
            assert!(
                normalize_base_url(fine).is_ok(),
                "should have accepted {}",
                fine
            );
        }
    }

    #[test]
    fn a_path_or_query_is_refused_rather_than_silently_dropped() {
        for input in [
            "https://drive.example.com/share",
            "https://drive.example.com/?a=b",
            "https://drive.example.com/#x",
        ] {
            assert!(normalize_base_url(input).is_err(), "should refuse {}", input);
        }
    }

    #[test]
    fn a_hostname_without_a_domain_is_refused() {
        assert!(normalize_base_url("drive").is_err());
        assert!(normalize_base_url("https://myserver").is_err());
    }
}

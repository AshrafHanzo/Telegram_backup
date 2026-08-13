//! Helpers shared by both share-link HTTP surfaces: the legacy single-file
//! `/d/{token}` routes (`share_routes.rs`) and the permissioned, folder-scoped
//! `/s/{token}` routes (`folder_share_routes.rs`).

use actix_web::HttpRequest;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Verify a password against a bcrypt hash.
pub fn verify_password(password: &str, hash: &str) -> bool {
    bcrypt::verify(password, hash).unwrap_or(false)
}

/// Derives a session-cookie value for a share link: a keyed digest of the
/// token, the share's own password hash, and an issue time, so the cookie is
/// only valid for this specific token/password pairing and can't be
/// replayed against a different share — and, via `verify_cookie_val`, can't
/// be replayed forever either, since the server enforces a real expiry
/// instead of trusting the cookie's own (client-side, unenforceable)
/// `max_age`. Format: `"<issued_at>.<sha256 hex>"` — the timestamp travels
/// in the clear (it's not a secret, just a bound) while the hash still ties
/// the value to this exact token+password_hash+time.
pub fn generate_cookie_val(token: &str, password_hash: &str, issued_at: i64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.update(password_hash.as_bytes());
    hasher.update(issued_at.to_le_bytes());
    format!("{}.{:x}", issued_at, hasher.finalize())
}

/// Verifies a cookie value produced by `generate_cookie_val`, both its
/// signature (constant-time) and that it was issued within `max_age_secs`
/// of now — a captured/replayed cookie stops working once it's stale,
/// instead of remaining valid forever the way a purely client-side
/// `max_age` would allow.
pub fn verify_cookie_val(value: &str, token: &str, password_hash: &str, max_age_secs: i64) -> bool {
    let Some((issued_at_str, signature)) = value.split_once('.') else { return false };
    let Ok(issued_at) = issued_at_str.parse::<i64>() else { return false };
    let now = chrono::Utc::now().timestamp();
    // A small allowance for clock skew on `issued_at > now`; anything older
    // than max_age is expired.
    if issued_at > now + 60 || now - issued_at > max_age_secs {
        return false;
    }
    let expected = generate_cookie_val(token, password_hash, issued_at);
    let Some((_, expected_signature)) = expected.split_once('.') else { return false };
    constant_time_eq::constant_time_eq(signature.as_bytes(), expected_signature.as_bytes())
}

pub fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

pub fn resolve_req_lang(req: &HttpRequest) -> (&'static str, &'static str) {
    if let Some(query) = req.uri().query() {
        if query.contains("lang=ar") { return ("ar", "rtl"); }
        if query.contains("lang=es") { return ("es", "ltr"); }
        if query.contains("lang=ru") { return ("ru", "ltr"); }
        if query.contains("lang=fr") { return ("fr", "ltr"); }
        if query.contains("lang=de") { return ("de", "ltr"); }
        if query.contains("lang=pt") { return ("pt-BR", "ltr"); }
        if query.contains("lang=zh") { return ("zh-CN", "ltr"); }
        if query.contains("lang=vi") { return ("vi", "ltr"); }
    }
    if let Some(accept) = req.headers().get("Accept-Language") {
        if let Ok(val) = accept.to_str() {
            if val.contains("ar") { return ("ar", "rtl"); }
            if val.contains("es") { return ("es", "ltr"); }
            if val.contains("ru") { return ("ru", "ltr"); }
            if val.contains("fr") { return ("fr", "ltr"); }
            if val.contains("de") { return ("de", "ltr"); }
            if val.contains("pt") { return ("pt-BR", "ltr"); }
            if val.contains("zh") { return ("zh-CN", "ltr"); }
            if val.contains("vi") { return ("vi", "ltr"); }
        }
    }
    ("en", "ltr")
}

/// Rate-limits password-verification attempts per share token: at most
/// `MAX_ATTEMPTS` within `WINDOW`, tracked independently per token. Applied
/// to both `/d/{token}/verify` and `/s/{token}/verify` — sharing this one
/// limiter (rather than adding it only to the new folder-share route) closes
/// a gap that already existed on the legacy file-share path.
pub struct VerifyRateLimiter {
    attempts: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl VerifyRateLimiter {
    const WINDOW: Duration = Duration::from_secs(15 * 60);
    const MAX_ATTEMPTS: usize = 10;

    pub fn new() -> Self {
        Self { attempts: Mutex::new(HashMap::new()) }
    }

    /// Records an attempt for `token` and returns `true` if it's allowed to
    /// proceed, `false` if this token has been attempted too many times
    /// within the current window.
    pub fn check_and_record(&self, token: &str) -> bool {
        let now = Instant::now();
        let mut attempts = match self.attempts.lock() {
            Ok(guard) => guard,
            Err(_) => return true, // Fail open on a poisoned lock rather than lock out everyone.
        };
        let entry = attempts.entry(token.to_string()).or_default();
        while let Some(front) = entry.front() {
            if now.duration_since(*front) > Self::WINDOW {
                entry.pop_front();
            } else {
                break;
            }
        }
        if entry.len() >= Self::MAX_ATTEMPTS {
            false
        } else {
            entry.push_back(now);
            true
        }
    }
}

impl Default for VerifyRateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_the_limit_then_blocks() {
        let limiter = VerifyRateLimiter::new();
        for _ in 0..VerifyRateLimiter::MAX_ATTEMPTS {
            assert!(limiter.check_and_record("token-a"));
        }
        assert!(!limiter.check_and_record("token-a"));
    }

    #[test]
    fn tracks_tokens_independently() {
        let limiter = VerifyRateLimiter::new();
        for _ in 0..VerifyRateLimiter::MAX_ATTEMPTS {
            assert!(limiter.check_and_record("token-a"));
        }
        assert!(!limiter.check_and_record("token-a"));
        assert!(limiter.check_and_record("token-b"));
    }
}

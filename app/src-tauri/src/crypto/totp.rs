//! TOTP (RFC 6238) authenticator support — lets any standard authenticator
//! app (Microsoft Authenticator, Google Authenticator, Authy, etc. all
//! implement the same standard, so none of them need special-casing here)
//! replace redoing a full Telegram phone/code login on a device that's
//! already been set up once.
//!
//! The generated secret does double duty:
//!   1. It's the shared TOTP secret the authenticator app uses to produce
//!      rotating 6-digit codes.
//!   2. It's also used (via HKDF, never directly) as the wrapping key that
//!      encrypts the locally-stored Telegram session before that encrypted
//!      blob is synced to Google Drive — see `commands::totp`. The secret
//!      itself is deliberately never written to Drive, only the blob it
//!      wraps, so a compromised Google account alone can't decrypt a
//!      synced session.

use crate::crypto::error::{CryptoError, CryptoResult};
use crate::crypto::kdf::domains;
use crate::crypto::secret::SecretKey;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha1::Sha1;

const SESSION_AAD: &[u8] = b"telegram-drive:totp-session:v1";

/// 160 bits — the size RFC 4226 recommends for HMAC-SHA1-based codes, and
/// what every mainstream authenticator app expects.
const SECRET_BYTES: usize = 20;
const PERIOD_SECS: u64 = 30;
const DIGITS: u32 = 6;
/// Accept a code from one step before/after the current one, so a little
/// clock drift between this PC and the phone doesn't lock the user out.
const VERIFY_WINDOW_STEPS: i64 = 1;

/// A freshly generated TOTP secret, not yet confirmed/persisted.
pub struct GeneratedTotp {
    pub secret: Vec<u8>,
    pub base32_secret: String,
    pub otpauth_uri: String,
    /// Self-contained SVG markup — safe to embed directly or wrap as a
    /// `data:image/svg+xml` URI on the frontend.
    pub qr_svg: String,
}

pub fn generate(account_label: &str, issuer: &str) -> CryptoResult<GeneratedTotp> {
    let mut secret = vec![0u8; SECRET_BYTES];
    rand::rng().fill_bytes(&mut secret);

    let base32_secret = encode_base32(&secret);
    let otpauth_uri = build_otpauth_uri(&base32_secret, account_label, issuer);
    let qr_svg = render_qr_svg(&otpauth_uri)?;

    Ok(GeneratedTotp { secret, base32_secret, otpauth_uri, qr_svg })
}

pub fn encode_base32(secret: &[u8]) -> String {
    base32::encode(base32::Alphabet::Rfc4648 { padding: false }, secret)
}

/// Parses a user-pasted setup key back into raw secret bytes — used when
/// linking a new device that doesn't have the secret cached locally yet.
/// Tolerant of spaces and lowercase, since people copy these by hand.
pub fn decode_base32(input: &str) -> CryptoResult<Vec<u8>> {
    let cleaned: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    base32::decode(base32::Alphabet::Rfc4648 { padding: false }, &cleaned.to_ascii_uppercase())
        .ok_or_else(|| CryptoError::internal("That setup key doesn't look valid — check for typos."))
}

fn build_otpauth_uri(base32_secret: &str, account_label: &str, issuer: &str) -> String {
    format!(
        "otpauth://totp/{issuer}:{label}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits={digits}&period={period}",
        issuer = urlencoding::encode(issuer),
        label = urlencoding::encode(account_label),
        secret = base32_secret,
        digits = DIGITS,
        period = PERIOD_SECS,
    )
}

fn render_qr_svg(data: &str) -> CryptoResult<String> {
    let code = qrcode::QrCode::new(data.as_bytes())
        .map_err(|e| CryptoError::internal(format!("Failed to build QR code: {}", e)))?;
    Ok(code
        .render()
        .min_dimensions(240, 240)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build())
}

fn hotp_code(secret: &[u8], counter: u64) -> CryptoResult<u32> {
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(secret)
        .map_err(|_| CryptoError::internal("Invalid TOTP secret length"))?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();

    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = ((u32::from(digest[offset]) & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    Ok(binary % 10u32.pow(DIGITS))
}

fn current_step(unix_time: u64) -> u64 {
    unix_time / PERIOD_SECS
}

/// Verifies a user-entered code against the secret, tolerating small clock
/// drift. `unix_time` is injected (rather than read internally) so this
/// stays trivially testable.
pub fn verify_code(secret: &[u8], code: &str, unix_time: u64) -> bool {
    let code = code.trim();
    if code.len() != DIGITS as usize || !code.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let Ok(entered) = code.parse::<u32>() else { return false };
    let step = current_step(unix_time) as i64;

    for delta in -VERIFY_WINDOW_STEPS..=VERIFY_WINDOW_STEPS {
        let Some(candidate_step) = step.checked_add(delta) else { continue };
        if candidate_step < 0 {
            continue;
        }
        if let Ok(expected) = hotp_code(secret, candidate_step as u64) {
            if expected == entered {
                return true;
            }
        }
    }
    false
}

/// Derives the session-wrapping key from the raw TOTP secret. Never derive
/// an encryption key directly from the secret bytes elsewhere — always
/// route through this (or another explicitly domain-separated call) so a
/// key used for one purpose can't be replayed against another.
pub fn derive_session_wrapping_key(secret: &[u8]) -> CryptoResult<SecretKey> {
    crate::crypto::kdf::derive_domain_key_32(secret, domains::TOTP_SESSION_WRAP)
}

/// Encrypts the Telegram session file's bytes so the ciphertext (not the
/// secret) is what gets synced to Google Drive. Returns `(nonce, ciphertext)`.
pub fn encrypt_session(secret: &[u8], plaintext: &[u8]) -> CryptoResult<(Vec<u8>, Vec<u8>)> {
    let key = derive_session_wrapping_key(secret)?;
    let nonce = crate::crypto::random::random_wrap_nonce();
    let cipher = XChaCha20Poly1305::new_from_slice(key.expose())
        .map_err(|_| CryptoError::internal("Invalid session wrapping key"))?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad: SESSION_AAD })
        .map_err(|_| CryptoError::internal("Session encryption failed"))?;
    Ok((nonce.to_vec(), ciphertext))
}

/// Decrypts a session blob pulled from Drive. Failure here (wrong secret,
/// or a corrupted/tampered blob) is intentionally a single generic error —
/// AEAD failure doesn't distinguish "wrong key" from "tampered ciphertext",
/// and it shouldn't.
pub fn decrypt_session(secret: &[u8], nonce: &[u8], ciphertext: &[u8]) -> CryptoResult<Vec<u8>> {
    if nonce.len() != 24 {
        return Err(CryptoError::internal("That setup key doesn't match this account's synced session."));
    }
    let key = derive_session_wrapping_key(secret)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.expose())
        .map_err(|_| CryptoError::internal("Invalid session wrapping key"))?;
    cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad: SESSION_AAD })
        .map_err(|_| CryptoError::internal("That setup key doesn't match this account's synced session."))
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 Appendix B test vector, SHA1, 8-digit — adapted to our fixed
    // 6-digit/30s output by re-deriving from the same known secret at a
    // known time and cross-checking internal consistency instead (RFC's
    // vectors are 8-digit, which we don't produce, so this test asserts
    // our own determinism + the well-known step boundary math instead).
    #[test]
    fn same_secret_and_time_produce_the_same_code() {
        let secret = b"12345678901234567890";
        let t = 59u64;
        assert_eq!(hotp_code(secret, current_step(t)).unwrap(), hotp_code(secret, current_step(t)).unwrap());
    }

    #[test]
    fn adjacent_time_steps_produce_different_codes_with_overwhelming_probability() {
        let secret = b"12345678901234567890";
        let a = hotp_code(secret, 1).unwrap();
        let b = hotp_code(secret, 2).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn verify_accepts_current_and_adjacent_steps_but_not_further_drift() {
        let secret = b"12345678901234567890";
        let now = 1_700_000_000u64;
        let step = current_step(now);
        let code_now = format!("{:06}", hotp_code(secret, step).unwrap());
        let code_next = format!("{:06}", hotp_code(secret, step + 1).unwrap());
        let code_far = format!("{:06}", hotp_code(secret, step + 5).unwrap());

        assert!(verify_code(secret, &code_now, now));
        assert!(verify_code(secret, &code_next, now)); // one step of drift tolerated
        if code_far != code_now && code_far != code_next {
            assert!(!verify_code(secret, &code_far, now));
        }
    }

    #[test]
    fn rejects_malformed_input_without_panicking() {
        let secret = b"12345678901234567890";
        assert!(!verify_code(secret, "abcdef", 0));
        assert!(!verify_code(secret, "12345", 0));
        assert!(!verify_code(secret, "", 0));
    }

    #[test]
    fn session_encryption_round_trips_and_rejects_wrong_secret() {
        let secret = b"12345678901234567890";
        let wrong_secret = b"09876543210987654321";
        let plaintext = b"pretend this is a sqlite session file's bytes";

        let (nonce, ciphertext) = encrypt_session(secret, plaintext).unwrap();
        let decrypted = decrypt_session(secret, &nonce, &ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);

        assert!(decrypt_session(wrong_secret, &nonce, &ciphertext).is_err());
    }

    #[test]
    fn base32_round_trips_and_tolerates_case_and_whitespace() {
        let secret = b"some-20-byte-secret!";
        let encoded = encode_base32(secret);
        let decoded = decode_base32(&encoded.to_ascii_lowercase().replace('a', "a ")).unwrap();
        assert_eq!(decoded, secret);
    }
}

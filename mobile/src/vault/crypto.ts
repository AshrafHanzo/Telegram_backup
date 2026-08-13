// Cryptographic primitives for the TDENC2/TDVLT2 formats, matching
// app/src-tauri/src/crypto/{kdf.rs,envelope/*.rs,vault/file.rs} byte-for-byte.
// This module has no React Native dependency so it can be exercised directly
// under Node (see scripts/verify-vault-vector.ts) against the desktop code's
// own known-answer test vector before ever touching real data on-device.
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes, utf8ToBytes } from "./bytes";

export const domains = {
  FILE_WRAP: utf8ToBytes("telegram-drive:file-wrap:v2"),
  METADATA_ENC: utf8ToBytes("telegram-drive:metadata-enc:v2"),
  CONTENT_ENC: utf8ToBytes("telegram-drive:content-enc:v2"),
  HEADER_AUTH: utf8ToBytes("telegram-drive:header-auth:v2"),
};

export class VaultCryptoError extends Error {}

// Matches kdf::derive_domain_key_32: HKDF-SHA256 with NO salt, ikm as the
// input keying material, domain as the `info` context, 32-byte output.
export function deriveDomainKey32(ikm: Uint8Array, domain: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, undefined, domain, 32);
}

// Matches kdf::derive_file_wrapping_key: HKDF-SHA256 with the slot's own
// salt as the HKDF salt, the vault/recovery master key as ikm.
export function deriveFileWrappingKey(
  masterKey: Uint8Array,
  fileUuid: Uint8Array,
  salt: Uint8Array,
  slotKind: number,
  slotId: number,
): Uint8Array {
  const info = concatBytes(domains.FILE_WRAP, fileUuid, Uint8Array.of(slotKind, slotId));
  return hkdf(sha256, masterKey, salt, info, 32);
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha256, key, message);
}

export function sha256Digest(message: Uint8Array): Uint8Array {
  return sha256(message);
}

// XChaCha20-Poly1305 decrypt. Throws VaultCryptoError on any authentication
// failure — never returns partial/unauthenticated plaintext.
export function xchachaDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new VaultCryptoError("Decryption failed: wrong key or corrupted data");
  }
}

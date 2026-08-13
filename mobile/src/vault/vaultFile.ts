// Byte-exact port of the read path in app/src-tauri/src/crypto/vault/file.rs
// (TDVLT2 format). Decrypt-only, matching this pass's "view-only" scope.
import { bytesEqual, concatBytes, readU16LE, readU32LE, utf8ToBytes } from "./bytes";
import { VaultCryptoError, xchachaDecrypt } from "./crypto";

const VAULT_MAGIC = utf8ToBytes("TDVLT2");
const VAULT_VERSION = 2;
const VAULT_AAD_DOMAIN = utf8ToBytes("telegram-drive:persistent-vault:v2");
const VAULT_HEADER_SIZE = 64;
const PAYLOAD_MAGIC = utf8ToBytes("TDVPL2");
const AEAD_TAG_LENGTH = 16;

export interface VaultFileHeader {
  memoryKib: number;
  iterations: number;
  parallelism: number;
  salt: Uint8Array;
  nonce: Uint8Array;
  ciphertextLength: number;
}

export function parseVaultFileHeader(bytes: Uint8Array): VaultFileHeader {
  if (bytes.length < VAULT_HEADER_SIZE + AEAD_TAG_LENGTH) {
    throw new VaultCryptoError("Truncated vault file");
  }
  if (!bytesEqual(bytes.slice(0, 6), VAULT_MAGIC)) {
    throw new VaultCryptoError("Not a Telegram Drive vault file");
  }
  const version = readU16LE(bytes, 6);
  if (version !== VAULT_VERSION) {
    throw new VaultCryptoError(`Unsupported vault format version ${version}`);
  }
  const memoryKib = readU32LE(bytes, 8);
  const iterations = readU32LE(bytes, 12);
  const parallelism = readU32LE(bytes, 16);
  const salt = bytes.slice(20, 36);
  const nonce = bytes.slice(36, 60);
  const ciphertextLength = readU32LE(bytes, 60);
  if (bytes.length !== VAULT_HEADER_SIZE + ciphertextLength) {
    throw new VaultCryptoError("Invalid vault ciphertext length");
  }
  return { memoryKib, iterations, parallelism, salt, nonce, ciphertextLength };
}

export interface VaultProfile {
  id: string;
  key: Uint8Array;
}

export interface VaultPayload {
  createdAt: bigint;
  vaultKey: Uint8Array;
  profiles: VaultProfile[];
}

export function decryptVaultPayload(
  fileBytes: Uint8Array,
  header: VaultFileHeader,
  unlockKey: Uint8Array,
): VaultPayload {
  const headerBytes = fileBytes.slice(0, VAULT_HEADER_SIZE);
  const aad = concatBytes(VAULT_AAD_DOMAIN, headerBytes);
  const ciphertext = fileBytes.slice(VAULT_HEADER_SIZE);
  const payload = xchachaDecrypt(unlockKey, header.nonce, aad, ciphertext);

  if (payload.length < 48 || !bytesEqual(payload.slice(0, 6), PAYLOAD_MAGIC)) {
    throw new VaultCryptoError("Wrong passphrase or corrupted vault");
  }

  let createdAt = 0n;
  for (let i = 7; i >= 0; i--) createdAt = (createdAt << 8n) | BigInt(payload[6 + i]);
  const vaultKey = payload.slice(14, 46);
  const count = readU16LE(payload, 46);

  let cursor = 48;
  const profiles: VaultProfile[] = [];
  for (let i = 0; i < count; i++) {
    const idLength = readU16LE(payload, cursor);
    cursor += 2;
    const idBytes = payload.slice(cursor, cursor + idLength);
    cursor += idLength;
    const key = payload.slice(cursor, cursor + 32);
    cursor += 32;
    profiles.push({ id: new TextDecoder().decode(idBytes), key });
  }
  if (cursor !== payload.length) {
    throw new VaultCryptoError("Trailing bytes in vault payload");
  }

  return { createdAt, vaultKey, profiles };
}

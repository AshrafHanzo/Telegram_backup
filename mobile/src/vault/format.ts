// Byte-exact port of app/src-tauri/src/crypto/envelope/{header,key_slot,decrypt_reader}.rs
// and crypto/vault/file.rs. Read-only (decrypt/unlock) on purpose — see
// crypto.ts's header comment. Every offset/constant here is taken directly
// from policy.rs; do not "simplify" the layout without re-checking that file.
import {
  bytesEqual,
  concatBytes,
  readU16LE,
  readU32LE,
  readU64LE,
  utf8ToBytes,
} from "./bytes";
import {
  deriveDomainKey32,
  deriveFileWrappingKey,
  hmacSha256,
  sha256Digest,
  VaultCryptoError,
  xchachaDecrypt,
  domains,
} from "./crypto";

const MAGIC = utf8ToBytes("TDENC2");
const LEGACY_MAGIC = utf8ToBytes("TDENC1");
const FORMAT_VERSION = 2;
const CIPHER_SUITE_XCHACHA20_POLY1305 = 1;
const AEAD_TAG_LENGTH = 16;
const CORE_HEADER_SIZE = 98;
const KEY_SLOT_SIZE = 104;
const FINAL_RECORD_PLAINTEXT_SIZE = 52;
const FINAL_RECORD_CIPHERTEXT_SIZE = FINAL_RECORD_PLAINTEXT_SIZE + AEAD_TAG_LENGTH;

// u64::MAX and u64::MAX - 1, little-endian.
const METADATA_NONCE_INDEX = new Uint8Array(8).fill(0xff);
const FINAL_RECORD_NONCE_INDEX = new Uint8Array([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

const HEADER_MAC_DOMAIN = utf8ToBytes("telegram-drive:tdenc2:header-mac");
const METADATA_AAD_DOMAIN = utf8ToBytes("telegram-drive:tdenc2:metadata");
const CHUNK_AAD_DOMAIN = utf8ToBytes("telegram-drive:tdenc2:chunk");
const FINAL_AAD_DOMAIN = utf8ToBytes("telegram-drive:tdenc2:final");
const SLOT_AAD_DOMAIN = utf8ToBytes("telegram-drive:tdenc2:key-slot");

export const SlotKind = { Vault: 1, Passphrase: 2, RecoveryKey: 3 } as const;
export const KdfAlgorithm = { Argon2id: 1, HkdfSha256: 2 } as const;

export interface KeySlot {
  kind: number;
  slotId: number;
  kdfAlgorithm: number;
  argon2MemoryKib: number;
  argon2Iterations: number;
  argon2Parallelism: number;
  salt: Uint8Array;
  wrapNonce: Uint8Array;
  wrappedDek: Uint8Array;
}

export interface CoreHeader {
  formatVersion: number;
  fileUuid: Uint8Array;
  headerLength: number;
  chunkSize: number;
  keySlotTableLength: number;
  encryptedMetadataLength: number;
  totalPlaintextLength: bigint;
  noncePrefix: Uint8Array;
  headerAuthenticator: Uint8Array;
}

export interface EnvelopeHeader {
  core: CoreHeader;
  keySlots: KeySlot[];
  encryptedMetadata: Uint8Array;
  rawHeader: Uint8Array;
}

function chunkCountFor(totalPlaintextLength: bigint, chunkSize: number): number {
  if (totalPlaintextLength === 0n) return 0;
  const size = BigInt(chunkSize);
  return Number((totalPlaintextLength + size - 1n) / size);
}

function parseCoreHeader(data: Uint8Array): CoreHeader {
  if (data.length < CORE_HEADER_SIZE) throw new VaultCryptoError("Truncated header");
  if (bytesEqual(data.slice(0, 6), LEGACY_MAGIC)) {
    throw new VaultCryptoError("Unsupported legacy TDENC1 format");
  }
  if (!bytesEqual(data.slice(0, 6), MAGIC)) {
    throw new VaultCryptoError("Invalid envelope magic");
  }

  const formatVersion = readU16LE(data, 6);
  if (formatVersion !== FORMAT_VERSION) {
    throw new VaultCryptoError(`Unsupported format version ${formatVersion}`);
  }
  const cipherSuite = readU16LE(data, 24);
  if (cipherSuite !== CIPHER_SUITE_XCHACHA20_POLY1305) {
    throw new VaultCryptoError("Unsupported cipher suite");
  }

  return {
    formatVersion,
    fileUuid: data.slice(8, 24),
    headerLength: readU32LE(data, 26),
    chunkSize: readU32LE(data, 30),
    keySlotTableLength: readU32LE(data, 34),
    encryptedMetadataLength: readU32LE(data, 38),
    totalPlaintextLength: readU64LE(data, 42),
    noncePrefix: data.slice(50, 66),
    headerAuthenticator: data.slice(66, 98),
  };
}

function parseKeySlot(data: Uint8Array, offset: number): KeySlot {
  const slot = data.slice(offset, offset + KEY_SLOT_SIZE);
  return {
    kind: slot[0],
    slotId: slot[1],
    kdfAlgorithm: readU16LE(slot, 2),
    argon2MemoryKib: readU32LE(slot, 4),
    argon2Iterations: readU32LE(slot, 8),
    argon2Parallelism: readU32LE(slot, 12),
    salt: slot.slice(16, 32),
    wrapNonce: slot.slice(32, 56),
    wrappedDek: slot.slice(56, 104),
  };
}

export function parseEnvelopeHeader(data: Uint8Array): EnvelopeHeader {
  const core = parseCoreHeader(data);
  if (data.length < core.headerLength) throw new VaultCryptoError("Truncated header");

  const slotCount = core.keySlotTableLength / KEY_SLOT_SIZE;
  const keySlots: KeySlot[] = [];
  for (let i = 0; i < slotCount; i++) {
    keySlots.push(parseKeySlot(data, CORE_HEADER_SIZE + i * KEY_SLOT_SIZE));
  }

  const metadataOffset = CORE_HEADER_SIZE + core.keySlotTableLength;
  const metadataEnd = metadataOffset + core.encryptedMetadataLength;
  const encryptedMetadata = data.slice(metadataOffset, metadataEnd);

  return { core, keySlots, encryptedMetadata, rawHeader: data.slice(0, core.headerLength) };
}

function buildSlotAad(slot: KeySlot, fileUuid: Uint8Array): Uint8Array {
  return concatBytes(
    SLOT_AAD_DOMAIN,
    Uint16LE(FORMAT_VERSION),
    fileUuid,
    Uint8Array.of(slot.kind, slot.slotId),
    Uint16LE(slot.kdfAlgorithm),
    Uint32LE(slot.argon2MemoryKib),
    Uint32LE(slot.argon2Iterations),
    Uint32LE(slot.argon2Parallelism),
    slot.salt,
  );
}

// Local, tiny wrappers so this file reads closer to the Rust source's own
// `.to_le_bytes()` call sites than a generic writeU16LE/writeU32LE would.
function Uint16LE(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}
function Uint32LE(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

// Matches key_slot::unwrap_dek exactly, given an already-derived wrapping
// key. Split out from unwrapDekFromVaultSlot so it can be exercised directly
// against the desktop code's known-answer test vector, which supplies the
// wrapping key directly rather than deriving it from a vault master key.
export function unwrapDekRaw(
  slot: KeySlot,
  fileUuid: Uint8Array,
  wrappingKey: Uint8Array,
): Uint8Array {
  const aad = buildSlotAad(slot, fileUuid);
  const dek = xchachaDecrypt(wrappingKey, slot.wrapNonce, aad, slot.wrappedDek);
  if (dek.length !== 32) throw new VaultCryptoError("Unexpected DEK length");
  return dek;
}

// Unwraps a file's DEK from a "Vault" key slot using the vault's master key
// (already derived from the passphrase — see vault.ts). Passphrase/recovery
// slot kinds aren't handled here since only vault-backed files are in scope
// for this read-only pass.
export function unwrapDekFromVaultSlot(
  slot: KeySlot,
  fileUuid: Uint8Array,
  vaultMasterKey: Uint8Array,
): Uint8Array {
  if (slot.kind !== SlotKind.Vault || slot.kdfAlgorithm !== KdfAlgorithm.HkdfSha256) {
    throw new VaultCryptoError("Only vault-backed key slots are supported");
  }
  const wrappingKey = deriveFileWrappingKey(vaultMasterKey, fileUuid, slot.salt, slot.kind, slot.slotId);
  return unwrapDekRaw(slot, fileUuid, wrappingKey);
}

function verifyAndDecryptMetadata(header: EnvelopeHeader, dek: Uint8Array): Uint8Array {
  const prefix = header.rawHeader.slice(0, 66);
  const authenticatedTail = header.rawHeader.slice(CORE_HEADER_SIZE);
  const headerKey = deriveDomainKey32(dek, domains.HEADER_AUTH);
  const expectedMac = hmacSha256(headerKey, concatBytes(HEADER_MAC_DOMAIN, prefix, authenticatedTail));
  if (!bytesEqual(expectedMac, header.core.headerAuthenticator)) {
    throw new VaultCryptoError("Header authentication failed — wrong key or corrupted file");
  }

  if (header.encryptedMetadata.length === 0) return new Uint8Array(0);

  const slotBytes = header.rawHeader.slice(
    CORE_HEADER_SIZE,
    CORE_HEADER_SIZE + header.core.keySlotTableLength,
  );
  const aad = concatBytes(METADATA_AAD_DOMAIN, prefix, slotBytes);
  const metadataKey = deriveDomainKey32(dek, domains.METADATA_ENC);
  const nonce = concatBytes(header.core.noncePrefix, METADATA_NONCE_INDEX);
  return xchachaDecrypt(metadataKey, nonce, aad, header.encryptedMetadata);
}

function chunkAad(header: EnvelopeHeader, chunkIndexBytes: Uint8Array, offsetBytes: Uint8Array, lengthBytes: Uint8Array): Uint8Array {
  return concatBytes(
    CHUNK_AAD_DOMAIN,
    Uint16LE(FORMAT_VERSION),
    header.core.fileUuid,
    header.core.headerAuthenticator,
    chunkIndexBytes,
    offsetBytes,
    lengthBytes,
    u64ToLeBytes(header.core.totalPlaintextLength),
  );
}

function finalAad(header: EnvelopeHeader, chunkCount: number): Uint8Array {
  return concatBytes(
    FINAL_AAD_DOMAIN,
    Uint16LE(FORMAT_VERSION),
    header.core.fileUuid,
    header.core.headerAuthenticator,
    Uint32LE(chunkCount),
    u64ToLeBytes(header.core.totalPlaintextLength),
  );
}

function u64ToLeBytes(value: bigint | number): Uint8Array {
  let big = typeof value === "bigint" ? value : BigInt(value);
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(big & 0xffn);
    big >>= 8n;
  }
  return bytes;
}

export interface DecryptedEnvelope {
  plaintext: Uint8Array;
  metadata: Uint8Array;
  fileUuid: Uint8Array;
}

// Decrypts a complete TDENC2 envelope in memory. Verifies the header
// authenticator, every chunk's AEAD tag, and the trailing whole-file SHA-256
// integrity record — any mismatch throws rather than returning partial data.
export function decryptEnvelope(envelope: Uint8Array, dek: Uint8Array): DecryptedEnvelope {
  const header = parseEnvelopeHeader(envelope);
  const metadata = verifyAndDecryptMetadata(header, dek);
  const contentKey = deriveDomainKey32(dek, domains.CONTENT_ENC);

  const body = envelope.slice(header.core.headerLength);
  const totalLength = header.core.totalPlaintextLength;
  const chunkCount = chunkCountFor(totalLength, header.core.chunkSize);

  const plaintextChunks: Uint8Array[] = [];
  let position = 0n;
  let bodyOffset = 0;

  for (let index = 0; index < chunkCount; index++) {
    const remaining = totalLength - position;
    const plaintextLength = Number(remaining < BigInt(header.core.chunkSize) ? remaining : BigInt(header.core.chunkSize));
    const ciphertextLength = plaintextLength + AEAD_TAG_LENGTH;
    const record = body.slice(bodyOffset, bodyOffset + ciphertextLength);
    if (record.length !== ciphertextLength) throw new VaultCryptoError("Truncated ciphertext");

    const nonce = concatBytes(header.core.noncePrefix, u64ToLeBytes(index));
    const aad = chunkAad(header, u64ToLeBytes(index), u64ToLeBytes(position), Uint32LE(plaintextLength));
    const plaintext = xchachaDecrypt(contentKey, nonce, aad, record);
    if (plaintext.length !== plaintextLength) throw new VaultCryptoError("Unexpected chunk length");

    plaintextChunks.push(plaintext);
    position += BigInt(plaintextLength);
    bodyOffset += ciphertextLength;
  }

  const finalRecord = body.slice(bodyOffset, bodyOffset + FINAL_RECORD_CIPHERTEXT_SIZE);
  if (finalRecord.length !== FINAL_RECORD_CIPHERTEXT_SIZE) {
    throw new VaultCryptoError("Missing or truncated final integrity record");
  }
  if (bodyOffset + FINAL_RECORD_CIPHERTEXT_SIZE !== body.length) {
    throw new VaultCryptoError("Trailing bytes after final record");
  }

  const finalNonce = concatBytes(header.core.noncePrefix, FINAL_RECORD_NONCE_INDEX);
  const finalPlaintext = xchachaDecrypt(contentKey, finalNonce, finalAad(header, chunkCount), finalRecord);
  if (finalPlaintext.length !== FINAL_RECORD_PLAINTEXT_SIZE) {
    throw new VaultCryptoError("Unexpected final record length");
  }

  const recordedChunkCount = readU32LE(finalPlaintext, 0);
  const recordedLength = readU64LE(finalPlaintext, 4);
  const recordedDigest = finalPlaintext.slice(12, 44);
  const reserved = finalPlaintext.slice(44, 52);

  const plaintext = concatBytes(...plaintextChunks);
  const actualDigest = sha256Digest(plaintext);

  if (
    recordedChunkCount !== chunkCount ||
    recordedLength !== totalLength ||
    position !== totalLength ||
    !reserved.every((b) => b === 0) ||
    !bytesEqual(recordedDigest, actualDigest)
  ) {
    throw new VaultCryptoError("Whole-file integrity check failed — wrong key or corrupted file");
  }

  return { plaintext, metadata, fileUuid: header.core.fileUuid };
}

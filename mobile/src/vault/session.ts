import argon2 from "react-native-argon2";
import { bytesToHex, hexToBytes } from "./bytes";
import { VaultCryptoError } from "./crypto";
import { decryptEnvelope, parseEnvelopeHeader, SlotKind, unwrapDekFromVaultSlot } from "./format";
import { decryptVaultPayload, parseVaultFileHeader, VaultProfile } from "./vaultFile";
import { checkAndRecord } from "../security/rateLimiter";

const UNLOCK_RATE_LIMIT_KEY = "vault_unlock";

// In-memory only, exactly like desktop's FileVault: never written to
// AsyncStorage/SecureStore, cleared on lock() or app restart.
let masterKey: Uint8Array | null = null;
let profiles: VaultProfile[] = [];

export function isUnlocked(): boolean {
  return masterKey !== null;
}

export function lock(): void {
  // Zero the actual key bytes in place before dropping the references, so
  // stale copies of the key material don't linger in the JS heap after
  // lock() — matching the "never written to storage, cleared on lock" intent
  // above (a dropped reference alone still leaves the bytes sitting in memory
  // until GC, which isn't guaranteed to happen promptly, if at all).
  if (masterKey) masterKey.fill(0);
  for (const profile of profiles) {
    profile.key.fill(0);
  }
  masterKey = null;
  profiles = [];
}

export async function unlock(vaultFileBytes: Uint8Array, passphrase: string): Promise<void> {
  if (!checkAndRecord(UNLOCK_RATE_LIMIT_KEY)) {
    throw new Error("Too many attempts. Please wait a few minutes and try again.");
  }
  const header = parseVaultFileHeader(vaultFileBytes);
  const result = await argon2(passphrase, bytesToHex(header.salt), {
    mode: "argon2id",
    saltEncoding: "hex",
    memory: header.memoryKib,
    iterations: header.iterations,
    parallelism: header.parallelism,
    hashLength: 32,
  });
  const unlockKey = hexToBytes(result.rawHash);
  const payload = decryptVaultPayload(vaultFileBytes, header, unlockKey);
  masterKey = payload.vaultKey;
  profiles = payload.profiles;
}

export interface DecryptedFile {
  plaintext: Uint8Array;
  name: string;
  mimeType?: string;
}

export function decryptFile(envelopeBytes: Uint8Array): DecryptedFile {
  if (!masterKey) throw new VaultCryptoError("Vault is locked");
  const header = parseEnvelopeHeader(envelopeBytes);
  const vaultSlot = header.keySlots.find((s) => s.kind === SlotKind.Vault);
  if (!vaultSlot) {
    throw new VaultCryptoError("This file has no vault-compatible key slot");
  }
  const dek = unwrapDekFromVaultSlot(vaultSlot, header.core.fileUuid, masterKey);
  const result = decryptEnvelope(envelopeBytes, dek);

  let name = "decrypted-file";
  let mimeType: string | undefined;
  const metadataText = new TextDecoder().decode(result.metadata);
  if (metadataText) {
    try {
      const parsed = JSON.parse(metadataText);
      if (typeof parsed.name === "string") name = parsed.name;
      if (typeof parsed.mime_type === "string") mimeType = parsed.mime_type;
    } catch {
      // No metadata, or metadata wasn't protected for this file — fall back
      // to the placeholder name; the caller already has the Telegram-side
      // randomized filename if it wants to use that instead.
    }
  }

  return { plaintext: result.plaintext, name, mimeType };
}

import * as Crypto from "expo-crypto";
import { Base64 } from "js-base64";

export type Argon2Mode = "argon2id" | "argon2i" | "argon2d";

export interface ParsedPhc {
  mode: Argon2Mode;
  version: number;
  memory: number;
  iterations: number;
  parallelism: number;
  saltHex: string;
  hashHex: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const VALID_MODES: Argon2Mode[] = ["argon2id", "argon2i", "argon2d"];

// Compatible with the PHC string format produced by both Rust's `argon2`
// crate (desktop) and react-native-argon2's `encodedHash` (mobile), so a
// lock password set on one device verifies correctly on the other.
export function parsePhc(phc: string): ParsedPhc {
  const parts = phc.split("$").filter(Boolean);
  if (parts.length !== 5) throw new Error("Malformed argon2 hash string");
  const [mode, versionPart, paramsPart, saltB64, hashB64] = parts;
  if (!VALID_MODES.includes(mode as Argon2Mode)) {
    throw new Error(`Unsupported argon2 mode: ${mode}`);
  }

  const params: Record<string, number> = {};
  for (const kv of paramsPart.split(",")) {
    const [key, value] = kv.split("=");
    params[key] = Number(value);
  }

  return {
    mode: mode as Argon2Mode,
    version: Number(versionPart.replace("v=", "")),
    memory: params.m,
    iterations: params.t,
    parallelism: params.p,
    saltHex: bytesToHex(Base64.toUint8Array(saltB64)),
    hashHex: bytesToHex(Base64.toUint8Array(hashB64)),
  };
}

export function randomSaltHex(byteLength = 16): string {
  return bytesToHex(Crypto.getRandomBytes(byteLength));
}

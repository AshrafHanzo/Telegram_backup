import AsyncStorage from "@react-native-async-storage/async-storage";
import argon2 from "react-native-argon2";
import * as LocalAuthentication from "expo-local-authentication";
import * as Drive from "../google/drive";
import { bytesEqual, hexToBytes } from "../vault/bytes";
import { parsePhc, randomSaltHex } from "./phc";
import { checkAndRecord } from "./rateLimiter";

const VERIFY_RATE_LIMIT_KEY = "app_lock_password_verify";

const ENABLED_KEY = "app_lock_enabled";
const EMAIL_KEY = "app_lock_email";
const HASH_KEY = "app_lock_password_hash";
const BIOMETRIC_KEY = "app_lock_biometric_enabled";

export interface AppLockStatus {
  enabled: boolean;
  email: string | null;
}

// Lets any later-resolving change here (most notably `syncFromDrive()`
// racing against `RootNavigator`'s boot-time lock check — see its own
// comment) trigger an immediate re-check instead of only taking effect at
// next app boot. Deliberately a plain listener set rather than a store: the
// only thing consumers need is "something changed, go re-read `getStatus()`
// yourself" — not the new value itself.
type LockChangeListener = () => void;
const lockChangeListeners = new Set<LockChangeListener>();

export function onLockChange(listener: LockChangeListener): () => void {
  lockChangeListeners.add(listener);
  return () => {
    lockChangeListeners.delete(listener);
  };
}

function notifyLockChange(): void {
  lockChangeListeners.forEach((listener) => listener());
}

export async function getStatus(): Promise<AppLockStatus> {
  const [enabled, email] = await Promise.all([
    AsyncStorage.getItem(ENABLED_KEY),
    AsyncStorage.getItem(EMAIL_KEY),
  ]);
  return { enabled: enabled === "true", email };
}

async function hashPassword(password: string): Promise<string> {
  const saltHex = randomSaltHex(16);
  const result = await argon2(password, saltHex, { mode: "argon2id", saltEncoding: "hex" });
  return result.encodedHash;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parsePhc(storedHash);
  const result = await argon2(password, parsed.saltHex, {
    mode: parsed.mode,
    saltEncoding: "hex",
    memory: parsed.memory,
    iterations: parsed.iterations,
    parallelism: parsed.parallelism,
    hashLength: parsed.hashHex.length / 2,
  });
  // Constant-time comparison — a variable-time `===` on the hex strings would
  // leak timing information about how many leading hash bytes matched.
  return bytesEqual(hexToBytes(result.rawHash), hexToBytes(parsed.hashHex));
}

export async function verifyCurrentPassword(password: string): Promise<boolean> {
  if (!checkAndRecord(VERIFY_RATE_LIMIT_KEY)) {
    throw new Error("Too many attempts. Please wait a few minutes and try again.");
  }
  const storedHash = await AsyncStorage.getItem(HASH_KEY);
  if (!storedHash) return false;
  return verifyPassword(password, storedHash);
}

// Sets (or resets) the lock password locally and best-effort pushes it to the
// same Google Drive appDataFolder blob the desktop app reads/writes, so the
// same password unlocks the app on either device.
export async function setPassword(email: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await AsyncStorage.multiSet([
    [ENABLED_KEY, "true"],
    [EMAIL_KEY, email],
    [HASH_KEY, hash],
  ]);
  // A new password is a materially new credential — require an explicit
  // re-enable (with its own live scan) rather than letting a biometric
  // flag left over from a previous, unrelated password silently apply to
  // this one. Mirrors `disable()` clearing it for the same reason.
  await AsyncStorage.setItem(BIOMETRIC_KEY, "false");
  try {
    await Drive.push({ app_lock: { email, password_hash: hash, enabled: true } });
  } catch {
    // Offline or not signed in — the local lock still works either way.
  }
  notifyLockChange();
}

// Pushes `enabled: false` to Drive (instead of just clearing locally) so a
// second device's next `syncFromDrive` sees the real current state instead
// of resurrecting the old enabled/password forever — see the matching fix
// in the desktop app's `cmd_set_app_lock_enabled`/`cache_from_drive`.
export async function disable(): Promise<void> {
  const [email, hash] = await Promise.all([
    AsyncStorage.getItem(EMAIL_KEY),
    AsyncStorage.getItem(HASH_KEY),
  ]);
  // Fingerprint unlock only ever makes sense as an alternate way into an
  // active lock — clear it along with the password so a later re-enable
  // starts from a clean, explicit choice rather than a dangling flag.
  await AsyncStorage.multiRemove([ENABLED_KEY, EMAIL_KEY, HASH_KEY, BIOMETRIC_KEY]);
  notifyLockChange();
  if (!email || !hash) return;
  try {
    await Drive.push({ app_lock: { email, password_hash: hash, enabled: false } });
  } catch {
    // Offline or not signed in — the local disable still applies either way.
  }
}

// ---------------------------------------------------------------------------
// Fingerprint/Face unlock — an alternate way into the SAME lock set up above,
// never a replacement for it (the password stays the source of truth, and
// is still what Drive-syncs across devices). Device biometrics are
// deliberately never involved in that sync: they're a per-device local
// convenience gate in front of a password this device already has cached.
// ---------------------------------------------------------------------------

export async function isBiometricHardwareAvailable(): Promise<boolean> {
  const [hasHardware, isEnrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hasHardware && isEnrolled;
}

// Only ever `true` if App Lock itself is currently enabled — self-corrects
// if the lock was disabled/reset without going through `disable()` for some
// reason, rather than trusting a possibly-stale flag on its own.
export async function isBiometricEnabled(): Promise<boolean> {
  const [enabled, biometric] = await Promise.all([
    AsyncStorage.getItem(ENABLED_KEY),
    AsyncStorage.getItem(BIOMETRIC_KEY),
  ]);
  return enabled === "true" && biometric === "true";
}

export async function authenticateWithBiometric(): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: "Unlock Telegram Drive",
    cancelLabel: "Use password",
    // This app already has its own password fallback right below the
    // prompt — disable the OS's own PIN/pattern fallback so "cancel" goes
    // straight back to that instead of asking for an unrelated device PIN.
    disableDeviceFallback: true,
  });
  return result.success;
}

// Turning it on requires a live successful scan first — proves the sensor
// actually works for this user before relying on it to gate the app.
export async function setBiometricEnabled(value: boolean): Promise<boolean> {
  if (!value) {
    await AsyncStorage.setItem(BIOMETRIC_KEY, "false");
    return true;
  }
  const status = await getStatus();
  if (!status.enabled) {
    throw new Error("Set up App Lock first.");
  }
  if (!(await isBiometricHardwareAvailable())) {
    throw new Error("No fingerprint or face unlock is set up on this device.");
  }
  const confirmed = await authenticateWithBiometric();
  if (!confirmed) return false;
  await AsyncStorage.setItem(BIOMETRIC_KEY, "true");
  return true;
}

// Pulls the app_lock blob down from Drive (e.g. right after Google sign-in on
// a new device) and caches it locally so App Lock works offline afterward.
export async function syncFromDrive(): Promise<void> {
  const payload = await Drive.pull();
  if (!payload?.app_lock) return;
  const enabled = payload.app_lock.enabled !== false;
  await AsyncStorage.multiSet([
    [ENABLED_KEY, enabled ? "true" : "false"],
    [EMAIL_KEY, payload.app_lock.email],
    [HASH_KEY, payload.app_lock.password_hash],
  ]);
  // Another device disabling the lock should also drop this device's
  // fingerprint flag — otherwise a later `setPassword()` on THIS device
  // would have found it already cleared anyway, but syncing it here too
  // keeps `getStatus()`-adjacent reads consistent in the meantime.
  if (!enabled) {
    await AsyncStorage.setItem(BIOMETRIC_KEY, "false");
  }
  notifyLockChange();
}

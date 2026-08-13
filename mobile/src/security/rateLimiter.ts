// Mirrors desktop's share_common::VerifyRateLimiter: N attempts per sliding
// window, keyed by caller-chosen string. In-memory only (cleared on app
// restart), which is fine for the same class of "throttle brute-force
// guessing while unlocked" defense-in-depth desktop uses this for.
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 10;

const attempts = new Map<string, number[]>();

export function checkAndRecord(
  key: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  windowMs = DEFAULT_WINDOW_MS,
): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= maxAttempts) {
    attempts.set(key, recent);
    return false;
  }
  recent.push(now);
  attempts.set(key, recent);
  return true;
}

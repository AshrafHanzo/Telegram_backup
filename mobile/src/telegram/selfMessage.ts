import * as Crypto from "expo-crypto";
import { ensureSavedMessagesChat, getMyProfile, sendTextMessage } from "./client";
import { checkAndRecord } from "../security/rateLimiter";
import { bytesEqual, hexToBytes } from "../vault/bytes";

const OTP_TTL_MS = 10 * 60 * 1000;
const SEND_RATE_LIMIT_KEY = "app_lock_otp_send";
const VERIFY_RATE_LIMIT_KEY = "app_lock_otp_verify";

interface PendingOtp {
  codeHash: string;
  expiresAt: number;
}

let pending: PendingOtp | null = null;

function randomOtpCode(): string {
  const bytes = Crypto.getRandomBytes(4);
  const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(100000 + (value % 900000));
}

async function hashCode(code: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, code);
}

// Sends a one-time code to the signed-in user's own Telegram "Saved Messages"
// chat, standing in for the desktop app's Gmail-SMTP OTP email (mobile can't
// open a raw SMTP connection, but it's already an authenticated Telegram
// client, so this reuses that existing session instead of adding a backend).
export async function sendSelfOtp(): Promise<void> {
  if (!checkAndRecord(SEND_RATE_LIMIT_KEY, 5)) {
    throw new Error("Too many codes requested. Please wait a few minutes and try again.");
  }
  const profile = await getMyProfile();
  const chatId = await ensureSavedMessagesChat(profile.id);
  const code = randomOtpCode();
  pending = { codeHash: await hashCode(code), expiresAt: Date.now() + OTP_TTL_MS };
  await sendTextMessage(
    chatId,
    `Your Telegram Drive verification code is ${code}. It expires in 10 minutes.`,
  );
}

export async function verifySelfOtp(code: string): Promise<boolean> {
  if (!checkAndRecord(VERIFY_RATE_LIMIT_KEY)) {
    throw new Error("Too many attempts. Please request a new code.");
  }
  if (!pending || Date.now() > pending.expiresAt) return false;
  // Constant-time comparison — a variable-time `===` on the hash hex strings
  // would leak timing information about how many leading hash bytes matched.
  const matches = bytesEqual(hexToBytes(await hashCode(code.trim())), hexToBytes(pending.codeHash));
  if (matches) pending = null;
  return matches;
}

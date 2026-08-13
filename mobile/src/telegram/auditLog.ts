// Reads the audit log desktop already syncs to Telegram Saved Messages
// (see app/src-tauri/src/audit_sync.rs — same [TD-AUDIT-LOG] marker
// message, same rolling 30-day window) so mobile can show the same
// history without needing its own separate sync path. Read-only for now:
// mobile doesn't yet push its own events into this log, only displays what
// desktop has already recorded.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ensureSavedMessagesChat, getChatHistory, getMyProfile } from "./client";
import { downloadFile } from "./download";

const AUDIT_LOG_MARKER = "[TD-AUDIT-LOG]";
const SCAN_PAGE_SIZE = 50;
const SCAN_MAX_PAGES = 6;
const LAST_SEEN_KEY = "audit_log_last_seen_at";

export interface AuditLogEntry {
  id: string;
  event_type: string;
  detail: string;
  file_name?: string | null;
  bytes?: number | null;
  source_id?: string | null;
  created_at: number;
}

async function savedMessagesChatId(): Promise<number> {
  const profile = await getMyProfile();
  return ensureSavedMessagesChat(profile.id);
}

async function findMarkerMessage(
  chatId: number,
): Promise<{ fileId: number; name: string } | null> {
  let fromMessageId = 0;
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const messages = await getChatHistory(chatId, fromMessageId, SCAN_PAGE_SIZE, 0);
    if (messages.length === 0) return null;
    for (const message of messages) {
      const doc = message.content?.document;
      const caption = message.content?.caption?.text;
      if (doc?.document && caption === AUDIT_LOG_MARKER) {
        return { fileId: doc.document.id, name: doc.file_name };
      }
    }
    if (messages.length < SCAN_PAGE_SIZE) return null;
    fromMessageId = messages[messages.length - 1].id;
  }
  return null;
}

export async function fetchAuditLog(): Promise<AuditLogEntry[]> {
  const chatId = await savedMessagesChatId();
  const match = await findMarkerMessage(chatId);
  if (!match) return [];
  const file = await downloadFile(match.fileId, match.name);
  const entries: AuditLogEntry[] = JSON.parse(await file.text());
  return entries.sort((a, b) => b.created_at - a.created_at);
}

export async function getLastSeenAt(): Promise<number> {
  const raw = await AsyncStorage.getItem(LAST_SEEN_KEY);
  return raw ? Number(raw) : 0;
}

export async function markAuditLogSeenNow(): Promise<void> {
  await AsyncStorage.setItem(LAST_SEEN_KEY, String(Math.floor(Date.now() / 1000)));
}

export function countUnread(entries: AuditLogEntry[], lastSeenAt: number): number {
  return entries.filter((e) => e.created_at > lastSeenAt).length;
}

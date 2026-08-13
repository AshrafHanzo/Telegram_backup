// Mirrors app/src-tauri/src/remote_catalog.rs exactly — mobile writes jobs
// and reads the catalog through the SAME two marked messages in Saved
// Messages, with no direct connection to the desktop at all. See that
// file's module doc for the full design.
import { Directory, File, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  deleteFile,
  ensureSavedMessagesChat,
  getChatHistory,
  getMyProfile,
  sendLocalDocumentTracked,
} from "./client";
import { downloadFile } from "./download";

const CATALOG_MARKER = "[TD-CATALOG]";
const JOBS_MARKER = "[TD-REMOTE-JOBS]";
const SCAN_PAGE_SIZE = 50;
const SCAN_MAX_PAGES = 6; // up to 300 messages, matching desktop's own scan cap

export interface CatalogEntry {
  relative_path: string;
  is_dir: boolean;
  // Rust's `Option<T>` serializes `None` as JSON `null`, not an omitted
  // key — these must accept `null`, not just `undefined`, or a missing
  // size/date (e.g. a file that vanished mid-walk on desktop) renders as
  // the literal string "null" instead of being treated as absent.
  size?: number | null;
  modified_at?: number | null;
  cover_base64?: string | null;
}

export interface SourceCatalog {
  source_id: string;
  display_name: string;
  entries: CatalogEntry[];
  truncated: boolean;
  synced_at: number;
}

export type RemoteJobAction =
  | { type: "add_source"; path: string; display_name?: string | null }
  | { type: "remove_source"; source_id: string }
  | {
      type: "copy_entry";
      source_id: string;
      relative_path: string;
      dest_source_id: string;
      dest_folder_path: string;
    }
  | {
      type: "move_entry";
      source_id: string;
      relative_path: string;
      dest_source_id: string;
      dest_folder_path: string;
    };

export type RemoteJobStatus = "pending" | "completed" | "failed";

export interface RemoteJob {
  id: string;
  action: RemoteJobAction;
  status: RemoteJobStatus;
  error?: string | null;
  created_at: number;
  completed_at?: number | null;
}

const ENABLED_KEY = "remote_backup_enabled";

// Gates the whole feature behind the "sync with Google account" toggle in
// Settings, per the user's own description of the feature — the toggle
// itself only flips this local flag; the Telegram Saved Messages plumbing
// above works independently of Google Sign-In.
export async function isRemoteBackupEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(ENABLED_KEY)) === "1";
}

export async function setRemoteBackupEnabled(value: boolean): Promise<void> {
  await AsyncStorage.setItem(ENABLED_KEY, value ? "1" : "0");
}

async function savedMessagesChatId(): Promise<number> {
  const profile = await getMyProfile();
  return ensureSavedMessagesChat(profile.id);
}

interface MarkerMatch {
  messageId: number;
  fileId: number;
  name: string;
}

async function findMarkerMessage(chatId: number, marker: string): Promise<MarkerMatch | null> {
  let fromMessageId = 0;
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const messages = await getChatHistory(chatId, fromMessageId, SCAN_PAGE_SIZE, 0);
    if (messages.length === 0) return null;
    for (const message of messages) {
      const doc = message.content?.document;
      const caption = message.content?.caption?.text;
      if (doc?.document && caption === marker) {
        return { messageId: message.id, fileId: doc.document.id, name: doc.file_name };
      }
    }
    if (messages.length < SCAN_PAGE_SIZE) return null;
    fromMessageId = messages[messages.length - 1].id;
  }
  return null;
}

async function downloadJson<T>(fileId: number, fileName: string): Promise<T> {
  const file = await downloadFile(fileId, fileName);
  return JSON.parse(await file.text());
}

async function publishJson(chatId: number, marker: string, fileName: string, data: unknown): Promise<void> {
  const existing = await findMarkerMessage(chatId, marker);
  if (existing) {
    await deleteFile(chatId, existing.messageId);
  }

  const tempDir = new Directory(Paths.cache, "remote-sync");
  if (!tempDir.exists) tempDir.create({ intermediates: true, idempotent: true });
  const tempFile = new File(tempDir, fileName);
  if (tempFile.exists) tempFile.delete();
  tempFile.create();
  tempFile.write(JSON.stringify(data));

  try {
    await sendLocalDocumentTracked(chatId, tempFile.uri, 60000, marker);
  } finally {
    if (tempFile.exists) tempFile.delete();
  }
}

export async function fetchCatalog(): Promise<SourceCatalog[]> {
  const chatId = await savedMessagesChatId();
  const match = await findMarkerMessage(chatId, CATALOG_MARKER);
  if (!match) return [];
  return downloadJson<SourceCatalog[]>(match.fileId, match.name);
}

async function fetchJobs(chatId: number): Promise<RemoteJob[]> {
  const match = await findMarkerMessage(chatId, JOBS_MARKER);
  if (!match) return [];
  return downloadJson<RemoteJob[]>(match.fileId, match.name);
}

export async function fetchJobStatus(): Promise<RemoteJob[]> {
  const chatId = await savedMessagesChatId();
  return fetchJobs(chatId);
}

function randomJobId(): string {
  return Array.from(Crypto.getRandomBytes(8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Serializes every job submission through this module. Without this, two
// near-simultaneous calls (e.g. tapping "Paste" then immediately "Remove"
// on another row before the first finishes) would each read the same
// existing job list and publish their own append — whichever publish lands
// second silently overwrites the other's job, and it's never processed.
// This also incidentally fixes a second issue: `sendLocalDocumentTracked`
// correlates its fire-and-forget send by chat+basename only, and every job
// publish uses the same fixed basename ("remote-jobs.json") — with two
// sends in flight at once, one send's success event could resolve both
// callers. Serializing means there's never more than one in flight.
let jobQueue: Promise<void> = Promise.resolve();

function withJobLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = jobQueue.then(fn, fn);
  jobQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function submitJob(action: RemoteJobAction): Promise<RemoteJob> {
  return withJobLock(async () => {
    const chatId = await savedMessagesChatId();
    const existing = await fetchJobs(chatId);
    const job: RemoteJob = {
      id: randomJobId(),
      action,
      status: "pending",
      error: null,
      created_at: Math.floor(Date.now() / 1000),
      completed_at: null,
    };
    await publishJson(chatId, JOBS_MARKER, "remote-jobs.json", [...existing, job]);
    return job;
  });
}

// Desktop resolves `path` on its own filesystem — mobile has no way to
// browse that filesystem, so this is a typed-in absolute path, same as
// pasting one into a text field the desktop app itself would show.
export function requestAddSource(path: string, displayName?: string): Promise<RemoteJob> {
  return submitJob({ type: "add_source", path, display_name: displayName ?? null });
}

export function requestRemoveSource(sourceId: string): Promise<RemoteJob> {
  return submitJob({ type: "remove_source", source_id: sourceId });
}

// Paste targets keep the original file/folder name — desktop resolves the
// full destination path as `<dest source root>/<dest_folder_path>/<basename>`.
export function requestCopyEntry(
  sourceId: string,
  relativePath: string,
  destSourceId: string,
  destFolderPath: string,
): Promise<RemoteJob> {
  return submitJob({
    type: "copy_entry",
    source_id: sourceId,
    relative_path: relativePath,
    dest_source_id: destSourceId,
    dest_folder_path: destFolderPath,
  });
}

export function requestMoveEntry(
  sourceId: string,
  relativePath: string,
  destSourceId: string,
  destFolderPath: string,
): Promise<RemoteJob> {
  return submitJob({
    type: "move_entry",
    source_id: sourceId,
    relative_path: relativePath,
    dest_source_id: destSourceId,
    dest_folder_path: destFolderPath,
  });
}

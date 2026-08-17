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
// Desktop → mobile only: the live folder-share list plus desktop's current
// public base URL. Mobile never writes this one; it requests changes through
// the job queue instead.
const SHARES_MARKER = "[TD-SHARES]";
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
    }
  // Asking desktop to create a real Temp Link. This phone can't serve one
  // itself (no HTTP server, no tunnel, and the OS suspends background apps),
  // and desktop resolves share tokens only from its own database.
  //
  // `share_id` is minted HERE, not by desktop, so a replayed job is a no-op
  // instead of a second live share — the jobs blob is last-write-wins with no
  // locking. `password_hash` is bcrypt-hashed on-device because this blob
  // lives indefinitely in Saved Messages and must never carry plaintext.
  // `folder_id` must be the raw channel id (`supergroupId`), NOT a TDLib
  // `-100…` chat id, or desktop's peer lookup will never match it.
  | {
      type: "create_folder_share";
      share_id: string;
      folder_id: number | null;
      folder_name: string;
      can_upload: boolean;
      can_download: boolean;
      can_update: boolean;
      can_delete: boolean;
      username?: string | null;
      password_hash?: string | null;
      expires_at?: number | null;
    }
  | { type: "revoke_folder_share"; share_id: string };

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

// `findMarkerMessage` only scans the newest ~300 messages, so "not found"
// genuinely means either "never created" or "pushed out of the scan window by
// newer messages" — and those need opposite handling. Treating the second as
// the first makes mobile publish a fresh one-item blob that erases the real
// one. Remembering that we've seen a marker before lets us fail loudly
// instead.
const SEEN_MARKER_PREFIX = "remote_sync_seen_marker_";

async function noteMarkerSeen(marker: string, messageId: number): Promise<void> {
  await AsyncStorage.setItem(SEEN_MARKER_PREFIX + marker, String(messageId));
}

async function hasSeenMarkerBefore(marker: string): Promise<boolean> {
  return (await AsyncStorage.getItem(SEEN_MARKER_PREFIX + marker)) !== null;
}

/// Like `findMarkerMessage`, but throws rather than reporting "absent" for a
/// marker this device has previously seen.
async function findMarkerMessageStrict(chatId: number, marker: string): Promise<MarkerMatch | null> {
  const match = await findMarkerMessage(chatId, marker);
  if (match) {
    await noteMarkerSeen(marker, match.messageId);
    return match;
  }
  if (await hasSeenMarkerBefore(marker)) {
    throw new Error(
      `${marker} was not found in the newest messages, but this device has seen it before. ` +
        `Refusing to continue so an existing list isn't overwritten — clear some Saved Messages ` +
        `clutter, or open the desktop app to republish.`,
    );
  }
  return null;
}

async function publishJson(chatId: number, marker: string, fileName: string, data: unknown): Promise<void> {
  // Locate the old marker but DON'T delete it yet: send the replacement
  // first, then remove the old one. Deleting up front (as this used to do)
  // means a failed send leaves no blob at all — silently wiping the whole
  // job queue or share list. Desktop's `publish_json` already orders it this
  // way; a duplicate marker is recoverable, a missing one isn't.
  const existing = await findMarkerMessageStrict(chatId, marker);

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

  if (existing) {
    await deleteFile(chatId, existing.messageId);
  }
}

/// One share as desktop publishes it. Mirrors `PublishedShare` in
/// `app/src-tauri/src/remote_catalog.rs`. Carries no password material —
/// only whether one is set.
export interface PublishedShare {
  id: string;
  folder_id?: number | null;
  folder_name: string;
  /// Bitfield, matching `SharePermissionBits`.
  permissions: number;
  has_password: boolean;
  username?: string | null;
  expires_at?: number | null;
  created_at: number;
}

/// Desktop's published share list plus the base URL to build links from.
/// Mirrors `SharePublication` in `remote_catalog.rs`.
export interface SharePublication {
  /// False when desktop has no public tunnel up — `base_url` is then a
  /// loopback address that's useless from this phone, so the UI must show a
  /// "waiting for your PC" state rather than an unusable link.
  public: boolean;
  base_url: string;
  updated_at: number;
  shares: PublishedShare[];
}

/// Reads the share list desktop publishes. Returns `null` when desktop has
/// never published one (i.e. it hasn't run since this feature shipped), which
/// the UI distinguishes from "published, but empty".
export async function fetchSharePublication(): Promise<SharePublication | null> {
  const chatId = await savedMessagesChatId();
  const match = await findMarkerMessageStrict(chatId, SHARES_MARKER);
  if (!match) return null;
  return downloadJson<SharePublication>(match.fileId, match.name);
}

/// Builds the URL for a share, or `null` when it can't be served right now.
/// Deliberately refuses to hand back desktop's loopback fallback: that URL
/// only works on the PC itself, so showing it here would look like a working
/// link that silently fails for everyone.
export function buildShareLink(publication: SharePublication, shareId: string): string | null {
  if (!publication.public) return null;
  const base = publication.base_url.replace(/\/+$/, "");
  if (base.includes("127.0.0.1") || base.includes("localhost")) return null;
  return `${base}/s/${shareId}`;
}

export async function fetchCatalog(): Promise<SourceCatalog[]> {
  const chatId = await savedMessagesChatId();
  const match = await findMarkerMessage(chatId, CATALOG_MARKER);
  if (!match) return [];
  return downloadJson<SourceCatalog[]>(match.fileId, match.name);
}

async function fetchJobs(chatId: number): Promise<RemoteJob[]> {
  const match = await findMarkerMessageStrict(chatId, JOBS_MARKER);
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

// --- Folder shares (Temp Links) ---------------------------------------------
//
// This phone can't serve a share link itself, so creating one means asking
// desktop to do it and waiting for desktop to publish the result. See
// `RemoteJobAction`'s `create_folder_share` docs for why the token is minted
// here and why the password arrives already hashed.

/// `folderId` MUST be the raw channel id (a folder's `supergroupId`), not a
/// TDLib `-100…` chat id: desktop matches against the raw id, so passing the
/// chat id produces a share that can never be served.
export function requestCreateFolderShare(params: {
  shareId: string;
  folderId: number | null;
  folderName: string;
  canUpload: boolean;
  canDownload: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  username?: string | null;
  passwordHash?: string | null;
  expiresAt?: number | null;
}): Promise<RemoteJob> {
  return submitJob({
    type: "create_folder_share",
    share_id: params.shareId,
    folder_id: params.folderId,
    folder_name: params.folderName,
    can_upload: params.canUpload,
    can_download: params.canDownload,
    can_update: params.canUpdate,
    can_delete: params.canDelete,
    username: params.username ?? null,
    password_hash: params.passwordHash ?? null,
    expires_at: params.expiresAt ?? null,
  });
}

export function requestRevokeFolderShare(shareId: string): Promise<RemoteJob> {
  return submitJob({ type: "revoke_folder_share", share_id: shareId });
}

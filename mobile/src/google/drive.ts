import { getAccessToken } from "./signin";

const SYNC_FILE_NAME = "telegram-drive-sync.json";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const MULTIPART_BOUNDARY = "telegram_drive_mobile_sync_boundary";

export interface SyncAppLock {
  email: string;
  password_hash: string;
  // Missing on blobs written before this field existed — treat as `true`
  // (matches what presence-of-this-section always implicitly meant before).
  enabled?: boolean;
}

export interface SyncFolderShare {
  id: string;
  folder_id: number;
  folder_name: string;
  permissions: number;
  username?: string;
  expires_at?: number;
  revoked: boolean;
  created_at: number;
}

export interface SyncPayload {
  api_id?: string;
  api_hash?: string;
  app_lock?: SyncAppLock;
  shares?: SyncFolderShare[];
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

async function findSyncFileId(): Promise<string | null> {
  const headers = await authHeaders();
  const query = encodeURIComponent(`name = '${SYNC_FILE_NAME}'`);
  const res = await fetch(`${FILES_URL}?spaces=appDataFolder&q=${query}&fields=files(id)`, {
    headers,
  });
  if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
  const data = await res.json();
  return data.files?.[0]?.id ?? null;
}

async function downloadSyncFile(fileId: string): Promise<SyncPayload> {
  const headers = await authHeaders();
  const res = await fetch(`${FILES_URL}/${fileId}?alt=media`, { headers });
  if (!res.ok) throw new Error(`Drive download failed: ${res.status}`);
  return res.json();
}

async function createSyncFile(payload: SyncPayload): Promise<string> {
  const token = await getAccessToken();
  const metadata = JSON.stringify({ name: SYNC_FILE_NAME, parents: ["appDataFolder"] });
  const body =
    `--${MULTIPART_BOUNDARY}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${MULTIPART_BOUNDARY}\r\n` +
    `Content-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n` +
    `--${MULTIPART_BOUNDARY}--`;

  const res = await fetch(`${UPLOAD_URL}?uploadType=multipart`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
  const data = await res.json();
  return data.id;
}

async function updateSyncFile(fileId: string, payload: SyncPayload): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`${UPLOAD_URL}/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Drive update failed: ${res.status}`);
}

export async function pull(): Promise<SyncPayload | null> {
  const fileId = await findSyncFileId();
  if (!fileId) return null;
  return downloadSyncFile(fileId);
}

// Serializes every `push()` call within this process — its download → merge
// → upload isn't atomic, so two callers racing (e.g. `appLock.setPassword`
// and `shares.createShare` both pushing around the same time) could each
// read the same stale snapshot and clobber the other's write. Mirrors
// `moveFiles`'s own `moveQueue` in telegram/client.ts for the same class of
// problem. This only fixes same-process/same-device races, not true
// cross-device conflicts — a full ETag/conditional-write scheme is out of
// scope.
let pushQueue: Promise<void> = Promise.resolve();

// Merge-aware: fields omitted from `partial` keep whatever is already on Drive.
export function push(partial: SyncPayload): Promise<void> {
  const run = async (): Promise<void> => {
    const fileId = await findSyncFileId();
    const existing = fileId ? await downloadSyncFile(fileId) : {};
    const merged: SyncPayload = { ...existing, ...partial };

    if (fileId) {
      await updateSyncFile(fileId, merged);
    } else {
      await createSyncFile(merged);
    }
  };

  const result = pushQueue.then(run, run);
  pushQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

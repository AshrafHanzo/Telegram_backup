import * as Crypto from "expo-crypto";
import * as Drive from "../google/drive";
import type { SyncFolderShare } from "../google/drive";

export type { SyncFolderShare as FolderShareRecord };

// Bit-compatible with desktop's SharePermissions (app/src-tauri/src/share_permissions.rs).
export const SharePermissionBits = {
  UPLOAD: 1,
  DOWNLOAD: 2,
  UPDATE: 4,
  DELETE: 8,
} as const;

function randomToken(): string {
  const bytes = Crypto.getRandomBytes(16);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Shares live in the same Google Drive appDataFolder blob as the Telegram
// credentials and App Lock settings, since it's the one place both the
// desktop and mobile apps already read/write. NOTE: the link itself is only
// servable while the desktop app is running its local HTTP server, and
// desktop currently reads share records from its own local SQLite database —
// it does not yet pull them from Drive, so links created here won't be
// servable until that sync is added on the desktop side too.
export async function listShares(): Promise<SyncFolderShare[]> {
  const payload = await Drive.pull();
  return payload?.shares ?? [];
}

export interface CreateShareParams {
  folderId: number;
  folderName: string;
  permissions: number;
  username?: string;
  expiresAt?: number;
}

export async function createShare(params: CreateShareParams): Promise<SyncFolderShare> {
  const record: SyncFolderShare = {
    id: randomToken(),
    folder_id: params.folderId,
    folder_name: params.folderName,
    permissions: params.permissions,
    username: params.username,
    expires_at: params.expiresAt,
    revoked: false,
    created_at: Math.floor(Date.now() / 1000),
  };
  const existing = await listShares();
  await Drive.push({ shares: [...existing, record] });
  return record;
}

export async function revokeShare(id: string): Promise<void> {
  const existing = await listShares();
  const updated = existing.map((s) => (s.id === id ? { ...s, revoked: true } : s));
  await Drive.push({ shares: updated });
}

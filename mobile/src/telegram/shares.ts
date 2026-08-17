// Folder shares ("Temp Links") as seen from the phone.
//
// This phone cannot serve a share link itself — it has no HTTP server, no
// Cloudflare tunnel, and the OS suspends background apps — and the desktop app
// resolves share tokens only from its own local database. So every change here
// is a *request* left for desktop in Telegram Saved Messages (see
// `remoteSync.ts`), and the authoritative share list is whatever desktop
// publishes back.
//
// This replaces an earlier Google-Drive-based implementation whose links could
// never work: desktop never read that blob, and it also sent the wrong folder
// identifier (see `createShare` below).
import * as Crypto from "expo-crypto";
import bcrypt from "bcryptjs";
import {
  buildShareLink,
  fetchSharePublication,
  requestCreateFolderShare,
  requestRevokeFolderShare,
  type PublishedShare,
  type SharePublication,
} from "./remoteSync";

export type { PublishedShare, SharePublication };

// Bit-compatible with desktop's SharePermissions (app/src-tauri/src/share_permissions.rs).
export const SharePermissionBits = {
  UPLOAD: 1,
  DOWNLOAD: 2,
  UPDATE: 4,
  DELETE: 8,
} as const;

// bcryptjs is pure JS and needs an explicit CSPRNG in React Native, where
// `crypto.getRandomValues` isn't available by default. Without this, salt
// generation throws.
bcrypt.setRandomFallback((length: number) => Array.from(Crypto.getRandomBytes(length)));

// Desktop hashes at cost 12, but that's noticeably slow in pure JS on a phone.
// 10 keeps link creation responsive and is still within the 4–14 range desktop
// accepts (see `validate_bcrypt_hash` in `remote_catalog.rs`).
const BCRYPT_COST = 10;

/// A share plus the link to reach it. `link` is null when desktop currently
/// has no public tunnel, in which case the share exists but isn't reachable
/// from this phone yet.
export interface ShareWithLink {
  share: PublishedShare;
  link: string | null;
}

/// What desktop last told us about shares. `publication` is null when desktop
/// has never published a list — distinct from "published, but empty".
export interface ShareListing {
  publication: SharePublication | null;
  items: ShareWithLink[];
}

function randomToken(): string {
  return Array.from(Crypto.getRandomBytes(16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function listShares(): Promise<ShareListing> {
  const publication = await fetchSharePublication();
  if (!publication) return { publication: null, items: [] };
  return {
    publication,
    items: publication.shares.map((share) => ({
      share,
      link: buildShareLink(publication, share.id),
    })),
  };
}

export interface CreateShareParams {
  /// The folder's raw channel id — a `TelegramFolder.supergroupId`, NOT its
  /// `chatId`. Desktop matches peers on the raw id, so passing the TDLib
  /// `-100…` chat id creates a share it can never serve.
  folderId: number;
  folderName: string;
  permissions: number;
  username?: string;
  password?: string;
  /// Absolute unix seconds. Absolute rather than a duration so the window
  /// doesn't silently restart from whenever desktop got around to the job.
  expiresAt?: number;
}

/// Queues a share request for desktop and returns the token it will be created
/// under. The token is minted here so that a replayed job (the shared job blob
/// is last-write-wins with no locking) results in a no-op rather than a second
/// live share.
export async function createShare(params: CreateShareParams): Promise<string> {
  const password = params.password?.trim();
  const username = params.username?.trim();
  if (username && !password) {
    throw new Error("Set a password before adding a username — a username alone isn't a login");
  }

  // Hashed on-device: the request travels through a JSON blob that lives
  // indefinitely in Saved Messages, so plaintext must never enter it.
  const passwordHash = password ? await bcrypt.hash(password, BCRYPT_COST) : null;

  const shareId = randomToken();
  await requestCreateFolderShare({
    shareId,
    folderId: params.folderId,
    folderName: params.folderName,
    canUpload: (params.permissions & SharePermissionBits.UPLOAD) !== 0,
    canDownload: (params.permissions & SharePermissionBits.DOWNLOAD) !== 0,
    canUpdate: (params.permissions & SharePermissionBits.UPDATE) !== 0,
    canDelete: (params.permissions & SharePermissionBits.DELETE) !== 0,
    username: username || null,
    passwordHash,
    expiresAt: params.expiresAt ?? null,
  });
  return shareId;
}

export async function revokeShare(id: string): Promise<void> {
  await requestRevokeFolderShare(id);
}

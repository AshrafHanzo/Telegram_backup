import {
  getChats,
  getSupergroup,
  loadChats,
  renameFolder as renameFolderRequest,
  requestCreateChannel,
  requestDeleteFolder,
  setFolderUsername,
  subscribeTo,
} from "./client";

export interface TelegramFolder {
  chatId: number;
  title: string;
  supergroupId: number;
}

const FOLDER_TAG = "[td]";
const LOAD_PAGE_SIZE = 50;
const MAX_CHATS_TO_SCAN = 500;

function isFolderChat(chat: any): boolean {
  const type = chat?.type;
  if (!type || type["@type"] !== "chatTypeSupergroup" || !type.is_channel) return false;
  return typeof chat.title === "string" && chat.title.toLowerCase().includes(FOLDER_TAG);
}

// Mirrors the desktop app's convention (app/src-tauri/src/commands/fs.rs): a
// folder is any channel whose title contains "[TD]" (case-insensitive).
export async function listFolders(): Promise<TelegramFolder[]> {
  let loaded = 0;
  let hasMore = true;
  while (hasMore && loaded < MAX_CHATS_TO_SCAN) {
    hasMore = await loadChats(LOAD_PAGE_SIZE);
    loaded += LOAD_PAGE_SIZE;
  }

  const chats = await getChats(loaded);
  return chats.filter(isFolderChat).map((chat) => ({
    chatId: chat.id,
    title: chat.title,
    supergroupId: chat.type.supergroup_id,
  }));
}

const CREATE_FOLDER_TIMEOUT_MS = 20000;

// createNewSupergroupChat is fire-and-forget in this TDLib binding — the created
// chat arrives asynchronously via updateNewChat, matched here by exact title.
// Tag placement matches desktop's real convention (channels.EditTitle sets
// "{name} [TD]", confirmed in app/src-tauri/src/commands/fs.rs) so folders
// created on either device look the same everywhere.
export function createFolder(name: string): Promise<TelegramFolder> {
  const title = name.toLowerCase().includes("[td]") ? name : `${name} [TD]`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the new folder to be created"));
    }, CREATE_FOLDER_TIMEOUT_MS);

    const unsubscribe = subscribeTo("updateNewChat", (data) => {
      const chat = data?.chat;
      if (!chat || chat.title !== title || !isFolderChat(chat)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve({ chatId: chat.id, title: chat.title, supergroupId: chat.type.supergroup_id });
    });

    requestCreateChannel(title);
  });
}

// Mirrors desktop's convention of keeping the "[TD]" tag on the title.
export async function renameFolder(chatId: number, newName: string): Promise<void> {
  const title = newName.toLowerCase().includes("[td]") ? newName : `${newName} [TD]`;
  await renameFolderRequest(chatId, title);
}

// No reliable confirmation event exists for channel deletion (see client.ts)
// — this fires the request; the caller should refresh the folder list after
// a short delay rather than wait on a promise.
export function deleteFolder(supergroupId: number): void {
  requestDeleteFolder(supergroupId);
}

function activeUsername(supergroup: any): string | null {
  return supergroup?.usernames?.active_usernames?.[0] ?? supergroup?.username ?? null;
}

export async function getFolderUsername(supergroupId: number): Promise<string | null> {
  const supergroup = await getSupergroup(supergroupId);
  return activeUsername(supergroup);
}

// Setting a username makes the folder's channel public and is required for
// getFolderInviteLink to return a link (see that function's doc comment for
// why an invite link can't be minted for a channel with no username).
export async function setFolderPublicUsername(
  supergroupId: number,
  username: string,
): Promise<string | null> {
  const result = await setFolderUsername(supergroupId, username);
  return activeUsername(result?.supergroup);
}

export async function clearFolderPublicUsername(supergroupId: number): Promise<void> {
  await setFolderUsername(supergroupId, "");
}

// TDLib's real invite-link-minting call (createChatInviteLink) is a
// direct-response-only method with no corresponding broadcast update, so it
// can't be observed through this library's fire-and-forget escape hatch.
// This only covers the case desktop also handles without an API call: a
// channel that already has a public username.
export async function getFolderInviteLink(supergroupId: number): Promise<string | null> {
  const username = await getFolderUsername(supergroupId);
  return username ? `https://t.me/${username}` : null;
}

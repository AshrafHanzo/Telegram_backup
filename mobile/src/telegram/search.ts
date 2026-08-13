import { listFolders } from "./folders";
import { listFiles, TelegramFile } from "./files";

export interface SearchResult extends TelegramFile {
  chatId: number;
  folderTitle: string;
}

// TDLib's real global search (searchMessages/searchMessagesGlobal) is a
// direct-response-only call this binding can't observe (see client.ts's
// sendAndAwaitUpdate doc comment), so this searches client-side across each
// folder's already-paged history instead of hitting Telegram's server-side
// search. Capped per folder to keep a personal-scale account responsive.
const MAX_PAGES_PER_FOLDER = 10;

export async function searchFiles(query: string): Promise<SearchResult[]> {
  const lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return [];

  const folders = await listFolders();
  const results: SearchResult[] = [];

  for (const folder of folders) {
    let fromMessageId = 0;
    let hasMore = true;
    let pages = 0;

    while (hasMore && pages < MAX_PAGES_PER_FOLDER) {
      const page = await listFiles(folder.chatId, fromMessageId);
      for (const file of page.files) {
        if (file.name.toLowerCase().includes(lowerQuery)) {
          results.push({ ...file, chatId: folder.chatId, folderTitle: folder.title });
        }
      }
      hasMore = page.hasMore && page.oldestMessageId !== null;
      fromMessageId = page.oldestMessageId ?? 0;
      pages++;
    }
  }

  return results;
}

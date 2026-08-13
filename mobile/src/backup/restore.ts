import { Directory, File } from "expo-file-system";
import { downloadFile } from "../telegram/download";
import { listFiles } from "../telegram/files";

export interface RestoreProgress {
  current: string;
}

export interface RestoreResult {
  downloaded: number;
  failed: number;
}

export async function runRestore(
  destinationDirUri: string,
  sourceChatId: number,
  onProgress?: (progress: RestoreProgress) => void,
): Promise<RestoreResult> {
  const destDir = new Directory(destinationDirUri);
  if (!destDir.exists) throw new Error("The restore destination folder is no longer accessible");

  let downloaded = 0;
  let failed = 0;
  let fromMessageId = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await listFiles(sourceChatId, fromMessageId);
    for (const file of page.files) {
      onProgress?.({ current: file.name });
      try {
        const localFile = await downloadFile(file.fileId, file.name);
        const target = new File(destDir, file.name);
        if (target.exists) target.delete();
        localFile.copySync(target);
        // Verify the copy actually landed intact when the source size is
        // known — a partial/corrupted copy shouldn't silently count as a
        // successful restore.
        if (file.size && file.size > 0 && target.info().size !== file.size) {
          if (target.exists) target.delete();
          throw new Error(`Downloaded size mismatch for "${file.name}"`);
        }
        downloaded++;
      } catch {
        failed++;
      }
    }
    hasMore = page.hasMore && page.oldestMessageId !== null;
    fromMessageId = page.oldestMessageId ?? 0;
  }

  return { downloaded, failed };
}

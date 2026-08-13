import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { requestDownload, subscribeTo } from "./client";
import { useTransferStore } from "./transferStore";

export interface DownloadProgress {
  downloadedSize: number;
  totalSize: number;
}

function toFileUri(path: string): string {
  return path.startsWith("file://") ? path : `file://${path}`;
}

export function downloadFile(
  fileId: number,
  fileName: string,
  onProgress?: (progress: DownloadProgress) => void,
  timeoutMs = 120000,
): Promise<File> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out downloading "${fileName}"`));
    }, timeoutMs);

    const unsubscribe = subscribeTo("updateFile", (data) => {
      const file = data?.file;
      if (!file || file.id !== fileId) return;

      onProgress?.({
        downloadedSize: file.local?.downloaded_size ?? 0,
        totalSize: file.size ?? file.expected_size ?? 0,
      });

      if (file.local?.is_downloading_completed) {
        clearTimeout(timer);
        unsubscribe();
        try {
          const downloadsDir = new Directory(Paths.document, "downloads");
          if (!downloadsDir.exists) {
            downloadsDir.create({ intermediates: true, idempotent: true });
          }
          const source = new File(toFileUri(file.local.path));
          const dest = new File(downloadsDir, fileName);
          if (dest.exists) dest.delete();
          source.copySync(dest);
          resolve(dest);
        } catch (e) {
          reject(e);
        }
      }
    });

    requestDownload(fileId);
  });
}

// Same as `downloadFile`, but registers with the global transfer store so
// it shows up in the persistent transfer bar — use this from any screen
// that wants the download to be visible/trackable app-wide, rather than
// wiring a one-off progress callback per call site.
export function downloadFileTracked(
  fileId: number,
  fileName: string,
  timeoutMs = 120000,
): Promise<File> {
  const id = `download-${fileId}-${fileName}`;
  const store = useTransferStore.getState();
  store.start(id, "download", fileName, 0);
  return downloadFile(
    fileId,
    fileName,
    (p) => store.progress(id, p.downloadedSize, p.totalSize),
    timeoutMs,
  ).then(
    (file) => {
      store.complete(id);
      return file;
    },
    (error) => {
      store.fail(id, error?.message ?? String(error));
      throw error;
    },
  );
}

export async function shareFile(file: File): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error("Sharing is not available on this device");
  await Sharing.shareAsync(file.uri);
}

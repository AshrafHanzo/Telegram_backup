// Mirrors desktop's RemoteUploadModal: send a file into a folder straight
// from a URL, without the user manually downloading it to the phone first.
//
// Uses a single buffered `arrayBuffer()` read rather than a streaming
// `response.body` reader — React Native's fetch implementation doesn't
// reliably support streaming response bodies across devices/engines, so
// this trades "live progress while fetching" for "definitely works": the
// fetch phase reports as a single indeterminate step, then the upload
// phase (once the file is local) gets real progress via the same TDLib
// file-events used everywhere else in this app.
import { Directory, File, Paths } from "expo-file-system";
import { useTransferStore } from "./transferStore";
import { uploadDocumentTracked } from "./upload";

function guessNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last || "download";
  } catch {
    return "download";
  }
}

export async function uploadFromUrl(
  chatId: number,
  url: string,
  displayName?: string,
): Promise<void> {
  const name = displayName?.trim() || guessNameFromUrl(url);
  const fetchId = `fetch-${chatId}-${name}-${Date.now()}`;
  const store = useTransferStore.getState();
  store.start(fetchId, "download", `Fetching ${name}`, 0);

  let bytes: Uint8Array;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    bytes = new Uint8Array(buffer);
    store.progress(fetchId, bytes.byteLength, bytes.byteLength);
    store.complete(fetchId);
  } catch (e: any) {
    store.fail(fetchId, e?.message ?? String(e));
    throw e;
  }

  const tempDir = new Directory(Paths.cache, "remote-upload");
  if (!tempDir.exists) tempDir.create({ intermediates: true, idempotent: true });
  const tempFile = new File(tempDir, name);
  if (tempFile.exists) tempFile.delete();
  tempFile.create();
  tempFile.write(bytes);

  try {
    await uploadDocumentTracked(chatId, { uri: tempFile.uri, name, size: bytes.byteLength });
  } finally {
    if (tempFile.exists) tempFile.delete();
  }
}

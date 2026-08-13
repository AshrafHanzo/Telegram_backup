import JSZip from "jszip";
import { Directory, File, Paths } from "expo-file-system";

export interface ArchiveEntry {
  path: string;
  isDirectory: boolean;
}

export async function openArchive(localFile: File): Promise<JSZip> {
  const bytes = await localFile.bytes();
  return JSZip.loadAsync(bytes);
}

export function listArchiveContents(zip: JSZip): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  zip.forEach((relativePath, entry) => {
    entries.push({ path: relativePath, isDirectory: entry.dir });
  });
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function extractArchiveEntry(zip: JSZip, entryPath: string): Promise<File> {
  const entry = zip.file(entryPath);
  if (!entry) throw new Error(`"${entryPath}" was not found in the archive`);

  const data = await entry.async("uint8array");
  const outDir = new Directory(Paths.cache, "extracted");
  if (!outDir.exists) outDir.create({ intermediates: true, idempotent: true });

  const outFile = new File(outDir, entryPath.split("/").pop() ?? entryPath);
  if (outFile.exists) outFile.delete();
  outFile.create();
  outFile.write(data);
  return outFile;
}

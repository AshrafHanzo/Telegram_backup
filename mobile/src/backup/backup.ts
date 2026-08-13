import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import { loadCredentials } from "../telegram/credentials";
import { sendLocalDocumentTracked, startClient, waitForAuthorizationReady } from "../telegram/client";

const SOURCE_KEY = "backup_source_uri";
const DEST_CHAT_ID_KEY = "backup_dest_chat_id";
const DEST_NAME_KEY = "backup_dest_name";

export interface BackupDestination {
  chatId: number;
  name: string;
}

export async function pickSource(): Promise<string> {
  const dir = await Directory.pickDirectoryAsync();
  await AsyncStorage.setItem(SOURCE_KEY, dir.uri);
  return dir.uri;
}

export async function getSource(): Promise<string | null> {
  return AsyncStorage.getItem(SOURCE_KEY);
}

export async function setDestination(destination: BackupDestination): Promise<void> {
  await AsyncStorage.multiSet([
    [DEST_CHAT_ID_KEY, String(destination.chatId)],
    [DEST_NAME_KEY, destination.name],
  ]);
}

export async function getDestination(): Promise<BackupDestination | null> {
  const pairs = await AsyncStorage.multiGet([DEST_CHAT_ID_KEY, DEST_NAME_KEY]);
  const chatIdStr = pairs[0][1];
  const name = pairs[1][1];
  if (!chatIdStr || !name) return null;
  return { chatId: Number(chatIdStr), name };
}

interface WalkedFile {
  file: File;
  relativePath: string;
}

function walk(dir: Directory, prefix: string): WalkedFile[] {
  const results: WalkedFile[] = [];
  for (const entry of dir.list()) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry instanceof Directory) {
      results.push(...walk(entry, relativePath));
    } else {
      results.push({ file: entry as File, relativePath });
    }
  }
  return results;
}

interface LedgerEntry {
  size: number;
  mtimeMs: number | null;
}
type Ledger = Record<string, LedgerEntry>;

function ledgerKeyFor(sourceUri: string, chatId: number): string {
  return `backup_ledger:${sourceUri}::${chatId}`;
}

async function loadLedger(key: string): Promise<Ledger> {
  const raw = await AsyncStorage.getItem(key);
  return raw ? JSON.parse(raw) : {};
}

async function saveLedger(key: string, ledger: Ledger): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(ledger));
}

export interface BackupProgress {
  total: number;
  completed: number;
  current?: string;
}

export interface BackupResult {
  uploaded: number;
  skipped: number;
  failed: number;
}

// Runs sequentially (one file at a time): each upload is copied into a
// scratch dir, sent, confirmed, then cleaned up before the next starts, so
// filename-based send-outcome matching in sendLocalDocumentTracked never has
// two in-flight uploads sharing the same basename.
export async function runBackup(onProgress?: (progress: BackupProgress) => void): Promise<BackupResult> {
  const sourceUri = await getSource();
  const destination = await getDestination();
  if (!sourceUri) throw new Error("Pick a folder to back up first");
  if (!destination) throw new Error("Pick a destination Telegram folder first");

  const credentials = await loadCredentials();
  if (!credentials) throw new Error("Telegram credentials are not set up yet");
  await startClient(credentials);
  // `startClient` resolving only means the native startTdLib call was
  // issued, not that TDLib finished restoring the authenticated session —
  // in the foreground this is masked by the UI only being reachable once
  // `useAuthStore` already reached "ready", but headless runs from
  // backgroundTask.ts have no such wait. Fail cleanly instead of silently
  // attempting uploads before the client can actually send anything.
  await waitForAuthorizationReady();

  const rootDir = new Directory(sourceUri);
  if (!rootDir.exists) throw new Error("The backup source folder is no longer accessible");

  const entries = walk(rootDir, "");
  const ledgerKey = ledgerKeyFor(sourceUri, destination.chatId);
  const ledger = await loadLedger(ledgerKey);

  const scratchDir = new Directory(Paths.cache, "backup-uploads");
  if (!scratchDir.exists) scratchDir.create({ intermediates: true, idempotent: true });

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i++) {
    const { file, relativePath } = entries[i];
    onProgress?.({ total: entries.length, completed: i, current: relativePath });

    const info = file.info();
    const size = info.size ?? 0;
    const mtimeMs = info.modificationTime ?? null;
    const prior = ledger[relativePath];
    if (prior && prior.size === size && prior.mtimeMs === mtimeMs) {
      skipped++;
      continue;
    }

    const scratchFile = new File(scratchDir, file.name);
    try {
      if (scratchFile.exists) scratchFile.delete();
      file.copySync(scratchFile);
      const remoteSize = await sendLocalDocumentTracked(destination.chatId, scratchFile.uri);
      // TDLib reported "succeeded" but the confirmed remote document size
      // doesn't match what was actually on disk — treat that as a failed
      // upload rather than recording a truncated/corrupted transfer as done.
      if (remoteSize !== undefined && remoteSize !== size) {
        throw new Error(
          `Uploaded size mismatch for "${relativePath}" (local ${size}, remote ${remoteSize})`,
        );
      }
      ledger[relativePath] = { size, mtimeMs };
      await saveLedger(ledgerKey, ledger);
      uploaded++;
    } catch {
      failed++;
    } finally {
      if (scratchFile.exists) scratchFile.delete();
    }
  }

  onProgress?.({ total: entries.length, completed: entries.length });
  return { uploaded, skipped, failed };
}

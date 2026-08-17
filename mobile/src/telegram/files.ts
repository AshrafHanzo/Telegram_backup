import {
  deleteFile as deleteFileRequest,
  getChatHistory,
  moveFiles as moveFilesRequest,
  MoveFilesResult,
  renameFile as renameFileRequest,
} from "./client";

export interface TelegramFile {
  messageId: number;
  date: number;
  kind: "document" | "photo" | "video";
  name: string;
  mimeType?: string;
  size?: number;
  fileId: number;
  minithumbnailData?: string;
  thumbnailFileId?: number;
}

const PAGE_SIZE = 50;

// Desktop splits files over Telegram's 2GB per-message limit into multiple
// part messages plus one text-only manifest message (see
// app/src-tauri/src/split_file.rs — same markers). The manifest is a plain
// text message, so it never matches toTelegramFile below and is already
// hidden; only the part documents need filtering out here, or they'd show
// up as duplicate, raw-caption-named junk.
const SPLIT_PART_MARKER = "[TD-SPLIT-PART]";

// Matches desktop's convention (extract_search_files in fs.rs): the message
// caption is the canonical display name when present, ahead of the
// document's own filename attribute.
function displayName(message: any, fallback: string): string {
  const caption = message.content?.caption?.text;
  return typeof caption === "string" && caption.length > 0 ? caption : fallback;
}

function fromDocumentMessage(message: any): TelegramFile | null {
  const doc = message.content?.document;
  if (!doc?.document) return null;
  return {
    messageId: message.id,
    date: message.date,
    kind: "document",
    name: displayName(message, doc.file_name || `document-${message.id}`),
    mimeType: doc.mime_type,
    size: doc.document.size,
    fileId: doc.document.id,
    minithumbnailData: doc.minithumbnail?.data,
    thumbnailFileId: doc.thumbnail?.file?.id,
  };
}

function fromPhotoMessage(message: any): TelegramFile | null {
  const photo = message.content?.photo;
  const sizes = photo?.sizes;
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  // Matches react-native-tdlib's own cookbook guidance: prefer the 'x' size
  // (TDLib's largest standard variant), falling back to the last entry —
  // sizes are conventionally ordered smallest-to-largest, but that ordering
  // isn't a guarantee, so 'x' is the more reliable pick when present.
  const largest = sizes.find((s: any) => s.type === "x") ?? sizes[sizes.length - 1];
  if (!largest?.photo) return null;
  return {
    messageId: message.id,
    date: message.date,
    kind: "photo",
    name: displayName(message, `photo-${message.id}.jpg`),
    size: largest.photo.size,
    fileId: largest.photo.id,
    minithumbnailData: photo?.minithumbnail?.data,
  };
}

function fromVideoMessage(message: any): TelegramFile | null {
  const video = message.content?.video;
  if (!video?.video) return null;
  return {
    messageId: message.id,
    date: message.date,
    kind: "video",
    name: displayName(message, video.file_name || `video-${message.id}.mp4`),
    mimeType: video.mime_type,
    size: video.video.size,
    fileId: video.video.id,
    minithumbnailData: video.minithumbnail?.data,
    thumbnailFileId: video.thumbnail?.file?.id,
  };
}

function toTelegramFile(message: any): TelegramFile | null {
  const caption = message.content?.caption?.text;
  if (typeof caption === "string" && caption.startsWith(SPLIT_PART_MARKER)) return null;

  const type = message.content?.["@type"];
  if (type === "messageDocument") return fromDocumentMessage(message);
  if (type === "messagePhoto") return fromPhotoMessage(message);
  if (type === "messageVideo") return fromVideoMessage(message);
  return null;
}

export interface FilePage {
  files: TelegramFile[];
  oldestMessageId: number | null;
  hasMore: boolean;
}

// fromMessageId=0 fetches the newest page; pass the previous page's
// oldestMessageId to continue paging backwards through history.
export async function listFiles(chatId: number, fromMessageId = 0): Promise<FilePage> {
  const messages = await getChatHistory(chatId, fromMessageId, PAGE_SIZE, 0);
  const files = messages.map(toTelegramFile).filter((f): f is TelegramFile => f !== null);
  const oldestMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
  return { files, oldestMessageId, hasMore: messages.length === PAGE_SIZE };
}

// Edits the message caption, which is what desktop treats as a file's name.
export async function renameFile(chatId: number, messageId: number, newName: string): Promise<void> {
  await renameFileRequest(chatId, messageId, newName);
}

export async function deleteFile(chatId: number, messageId: number): Promise<void> {
  await deleteFileRequest(chatId, messageId);
}

export async function moveFiles(
  sourceChatId: number,
  destChatId: number,
  messageIds: number[],
): Promise<MoveFilesResult> {
  return moveFilesRequest(sourceChatId, destChatId, messageIds);
}

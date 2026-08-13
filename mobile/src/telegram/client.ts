import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import TdLib from "react-native-tdlib";
import type { TelegramCredentials } from "./credentials";

const emitter = new NativeEventEmitter(NativeModules.TdLibModule);

export interface TdUpdate {
  type: string;
  data: any;
}

export function subscribe(listener: (update: TdUpdate) => void): () => void {
  const sub = emitter.addListener("tdlib-update", (event: { type: string; raw: string }) => {
    let data: any;
    try {
      data = JSON.parse(event.raw);
    } catch {
      return;
    }
    listener({ type: event.type, data });
  });
  return () => sub.remove();
}

export function subscribeTo(type: string, listener: (data: any) => void): () => void {
  return subscribe((update) => {
    if (update.type === type) listener(update.data);
  });
}

export async function startClient(creds: TelegramCredentials): Promise<void> {
  await TdLib.startTdLib({
    api_id: creds.apiId,
    api_hash: creds.apiHash,
    device_model: Platform.OS === "ios" ? "iPhone" : "Android",
    system_version: String(Platform.Version ?? "1.0"),
    application_version: "1.0.0",
    system_language_code: "en",
  });
}

// For headless/background contexts (see backup.ts's `runBackup`, used from
// backgroundTask.ts) that have no UI-driven `useAuthStore` already watching
// `updateAuthorizationState` — there, `startClient()` resolving only means
// the native startTdLib call was issued, not that TDLib finished restoring
// the authenticated session. Polls the actual current state via
// `getAuthorizationState` rather than only waiting for a fresh
// `updateAuthorizationState` event, since that event may never re-fire if
// the session was already ready before this was called (e.g. the normal
// foreground path). Mirrors `moveFiles`'s deadline-poll loop shape below.
export async function waitForAuthorizationReady(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await TdLib.getAuthorizationState();
    const type = JSON.parse(raw)?.["@type"];
    if (type === "authorizationStateReady") return;
    if (type === "authorizationStateClosed") {
      throw new Error("Telegram client closed before it finished signing in");
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Telegram to finish signing in");
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function submitPhone(countryCode: string, phoneNumber: string): Promise<void> {
  await TdLib.login({ countrycode: countryCode, phoneNumber });
}

export async function submitCode(code: string): Promise<void> {
  await TdLib.verifyPhoneNumber(code);
}

export async function submitPassword(password: string): Promise<void> {
  await TdLib.verifyPassword(password);
}

export async function logout(): Promise<void> {
  await TdLib.logout();
}

export async function loadChats(limit: number): Promise<boolean> {
  try {
    const result = await TdLib.loadChats(limit);
    return result !== "No more chats to load";
  } catch {
    return false;
  }
}

export async function getChats(limit: number): Promise<any[]> {
  const raw = await TdLib.getChats(limit);
  return JSON.parse(raw);
}

export async function getSupergroup(supergroupId: number): Promise<any> {
  const result = await TdLib.getSupergroup(supergroupId);
  return JSON.parse(result.raw);
}

export async function openChat(chatId: number): Promise<void> {
  await TdLib.openChat(chatId);
}

export async function closeChat(chatId: number): Promise<void> {
  await TdLib.closeChat(chatId);
}

export async function getChatHistory(
  chatId: number,
  fromMessageId: number,
  limit: number,
  offset: number,
): Promise<any[]> {
  const items = await TdLib.getChatHistory(chatId, fromMessageId, limit, offset);
  return items.map((it) => JSON.parse(it.raw_json));
}

export async function sendTextMessage(
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  await TdLib.sendMessage(chatId, text, replyToMessageId);
}

export function requestDownload(fileId: number): void {
  TdLib.td_json_client_send({
    "@type": "downloadFile",
    file_id: fileId,
    priority: 1,
    offset: 0,
    limit: 0,
    synchronous: false,
  });
}

export async function getMyProfile(): Promise<any> {
  const raw = await TdLib.getProfile();
  return JSON.parse(raw);
}

export async function ensureSavedMessagesChat(userId: number): Promise<number> {
  const raw = await TdLib.createPrivateChat(userId);
  return JSON.parse(raw).id;
}

// Serializes every `sendLocalDocumentTracked`/`sendLocalDocumentWithProgress`
// call app-wide. Both correlate their outcome events by chat_id + document
// file_name only (see the comment on `sendLocalDocumentTracked` below) —
// two concurrent sends to the same chat with the same basename would each
// match against the other's completion event. Running one send at a time
// removes the ambiguity entirely, mirroring `moveFiles`'s own `moveQueue`
// fix for the exact same class of problem.
let sendQueue: Promise<void> = Promise.resolve();

function queueSend<T>(run: () => Promise<T>): Promise<T> {
  const result = sendQueue.then(run, run);
  sendQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Correlates a fire-and-forget document send with its outcome by matching
// updateMessageSendSucceeded/Failed against the file's basename, since this
// binding gives no direct handle on the temporary local message it creates.
// Resolves with the confirmed remote document size (when TDLib reports one)
// so callers like `runBackup` can verify the upload wasn't truncated instead
// of just trusting that "succeeded" means "arrived intact".
export function sendLocalDocumentTracked(
  chatId: number,
  localPath: string,
  timeoutMs = 60000,
  caption?: string,
): Promise<number | undefined> {
  const path = localPath.startsWith("file://") ? localPath.slice("file://".length) : localPath;
  const baseName = path.split("/").pop() ?? path;

  return queueSend(
    () =>
      new Promise<number | undefined>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubSucceeded();
          unsubFailed();
          reject(new Error(`Timed out waiting for "${baseName}" to finish sending`));
        }, timeoutMs);

        const finish = (fn: () => void) => {
          clearTimeout(timer);
          unsubSucceeded();
          unsubFailed();
          fn();
        };

        const unsubSucceeded = subscribeTo("updateMessageSendSucceeded", (data) => {
          const message = data?.message;
          if (message?.chat_id !== chatId) return;
          if (message?.content?.document?.file_name !== baseName) return;
          const remoteSize = message?.content?.document?.document?.size;
          finish(() => resolve(typeof remoteSize === "number" ? remoteSize : undefined));
        });

        const unsubFailed = subscribeTo("updateMessageSendFailed", (data) => {
          const message = data?.message;
          if (message?.chat_id !== chatId) return;
          if (message?.content?.document?.file_name !== baseName) return;
          finish(() => reject(new Error(data?.error_message ?? "Send failed")));
        });

        TdLib.td_json_client_send({
          "@type": "sendMessage",
          chat_id: chatId,
          input_message_content: {
            "@type": "inputMessageDocument",
            document: { "@type": "inputFileLocal", path },
            disable_content_type_detection: true,
            ...(caption ? { caption: { "@type": "formattedText", text: caption } } : {}),
          },
        });
      }),
  );
}

// Same correlation as `sendLocalDocumentTracked` for the final
// resolve/reject, plus a best-effort progress feed: the pending message's
// own `updateNewMessage` carries the file id TDLib assigned to the upload,
// which subsequent `updateFile` events report `remote.uploaded_size`
// against (the upload-direction mirror of the `local.downloaded_size` used
// for download progress elsewhere in this file). If that file id is never
// captured for some reason, `onProgress` just never fires — no crash, the
// caller still resolves/rejects normally from the same succeeded/failed
// events `sendLocalDocumentTracked` already relies on.
export function sendLocalDocumentWithProgress(
  chatId: number,
  localPath: string,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
  timeoutMs = 300000,
  caption?: string,
): Promise<void> {
  const path = localPath.startsWith("file://") ? localPath.slice("file://".length) : localPath;
  const baseName = path.split("/").pop() ?? path;

  return queueSend(
    () =>
      new Promise<void>((resolve, reject) => {
        let trackedFileId: number | null = null;

        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for "${baseName}" to finish sending`));
        }, timeoutMs);

        const cleanup = () => {
          clearTimeout(timer);
          unsubNewMessage();
          unsubUpdateFile();
          unsubSucceeded();
          unsubFailed();
        };

        const unsubNewMessage = subscribeTo("updateNewMessage", (data) => {
          const message = data?.message;
          if (message?.chat_id !== chatId) return;
          const doc = message?.content?.document;
          if (doc?.file_name !== baseName) return;
          trackedFileId = doc?.document?.id ?? null;
        });

        const unsubUpdateFile = subscribeTo("updateFile", (data) => {
          const file = data?.file;
          if (!file || trackedFileId === null || file.id !== trackedFileId) return;
          const uploaded = file.remote?.uploaded_size ?? 0;
          const total = file.size ?? file.expected_size ?? 0;
          onProgress?.(uploaded, total);
        });

        const unsubSucceeded = subscribeTo("updateMessageSendSucceeded", (data) => {
          const message = data?.message;
          if (message?.chat_id !== chatId) return;
          if (message?.content?.document?.file_name !== baseName) return;
          cleanup();
          resolve();
        });

        const unsubFailed = subscribeTo("updateMessageSendFailed", (data) => {
          const message = data?.message;
          if (message?.chat_id !== chatId) return;
          if (message?.content?.document?.file_name !== baseName) return;
          cleanup();
          reject(new Error(data?.error_message ?? "Send failed"));
        });

        TdLib.td_json_client_send({
          "@type": "sendMessage",
          chat_id: chatId,
          input_message_content: {
            "@type": "inputMessageDocument",
            document: { "@type": "inputFileLocal", path },
            disable_content_type_detection: true,
            ...(caption ? { caption: { "@type": "formattedText", text: caption } } : {}),
          },
        });
      }),
  );
}

export function requestCreateChannel(title: string): void {
  TdLib.td_json_client_send({
    "@type": "createNewSupergroupChat",
    title,
    is_forum: false,
    is_channel: true,
    description: "",
  });
}

// Generic fire-and-forget correlation: sends `request`, then resolves the
// first time `updateType` fires with data matching `isMatch`. Only usable for
// TDLib calls whose effect also shows up as a spontaneous broadcast update —
// this binding's td_json_client_send discards the call's own direct response
// (confirmed in the native module: requests sent this way are registered with
// no result handler, so TDLib's reply is dropped rather than rebroadcast).
function sendAndAwaitUpdate<T = any>(
  request: Record<string, unknown>,
  updateType: string,
  isMatch: (data: any) => boolean,
  timeoutMs = 20000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${updateType}`));
    }, timeoutMs);

    const unsubscribe = subscribeTo(updateType, (data) => {
      if (!isMatch(data)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(data);
    });

    TdLib.td_json_client_send(request);
  });
}

export async function renameFile(chatId: number, messageId: number, newName: string): Promise<void> {
  await sendAndAwaitUpdate(
    {
      "@type": "editMessageCaption",
      chat_id: chatId,
      message_id: messageId,
      caption: { "@type": "formattedText", text: newName },
    },
    "updateMessageContent",
    (data) => data?.chat_id === chatId && data?.message_id === messageId,
  );
}

export async function renameFolder(chatId: number, newTitle: string): Promise<void> {
  await sendAndAwaitUpdate(
    { "@type": "setChatTitle", chat_id: chatId, title: newTitle },
    "updateChatTitle",
    (data) => data?.chat_id === chatId,
  );
}

export async function deleteFile(chatId: number, messageId: number): Promise<void> {
  await TdLib.deleteMessages(chatId, [messageId], true);
}

// No single broadcast update reliably confirms channel deletion, so this
// fires the request and gives the caller a moment before it refreshes state,
// rather than blocking indefinitely on an event that may never arrive.
export function requestDeleteFolder(supergroupId: number): void {
  TdLib.td_json_client_send({ "@type": "deleteSupergroup", supergroup_id: supergroupId });
}

export interface MoveFilesResult {
  movedCount: number;
  requestedCount: number;
}

// Serializes every `moveFiles` call app-wide. The confirmation listener
// below only filters by destination chat + content type, with no
// correlation to which specific messageIds a given call is waiting on — two
// overlapping moves TO THE SAME destination chat would each count the
// other's arrivals too, letting one call reach "confirmed" purely from the
// other's traffic and delete its own originals before its own forward
// actually landed (permanent data loss if that forward then fails or is
// delayed). Running one move at a time removes the ambiguity entirely
// instead of trying to guess whether TDLib's forward_info reliably
// round-trips enough detail to correlate by message id.
let moveQueue: Promise<void> = Promise.resolve();

// Forwards messages to `destChatId`, counts confirmed arrivals via
// updateNewMessage within the timeout, and only deletes the originals from
// `sourceChatId` if every forwarded message was confirmed — mirroring the
// desktop app's own safety net of not deleting without confirmation.
export function moveFiles(
  sourceChatId: number,
  destChatId: number,
  messageIds: number[],
  timeoutMs = 30000,
): Promise<MoveFilesResult> {
  const run = async (): Promise<MoveFilesResult> => {
    let confirmed = 0;
    const unsubscribe = subscribeTo("updateNewMessage", (data) => {
      const message = data?.message;
      if (message?.chat_id !== destChatId) return;
      // Narrow to file-bearing content so unrelated activity in the destination
      // (a self-notification, someone else's message) can't inflate the count
      // and trigger deleting originals before the forward actually completed.
      const type = message?.content?.["@type"];
      if (type === "messageDocument" || type === "messagePhoto" || type === "messageVideo") {
        confirmed++;
      }
    });

    TdLib.td_json_client_send({
      "@type": "forwardMessages",
      chat_id: destChatId,
      message_thread_id: 0,
      from_chat_id: sourceChatId,
      message_ids: messageIds,
      options: {},
      send_copy: false,
      remove_caption: false,
    });

    const deadline = Date.now() + timeoutMs;
    while (confirmed < messageIds.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }
    unsubscribe();

    if (confirmed >= messageIds.length) {
      await TdLib.deleteMessages(sourceChatId, messageIds, true);
    }
    return { movedCount: Math.min(confirmed, messageIds.length), requestedCount: messageIds.length };
  };

  const result = moveQueue.then(run, run);
  moveQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function setFolderUsername(supergroupId: number, username: string): Promise<any> {
  return sendAndAwaitUpdate(
    { "@type": "setSupergroupUsername", supergroup_id: supergroupId, username },
    "updateSupergroup",
    (data) => data?.supergroup?.id === supergroupId,
  );
}

// getProxies/the addProxy response are both direct-response-only (see
// sendAndAwaitUpdate's doc comment) so this can't report back a proxy ID —
// but addProxy(enable: true) activates immediately and disableProxy always
// clears whatever is active, so no ID tracking is actually needed for a
// simple "use this proxy" / "stop using a proxy" toggle.
export function requestAddProxy(
  server: string,
  port: number,
  kind: "socks5" | "http",
  username?: string,
  password?: string,
): void {
  const type =
    kind === "socks5"
      ? { "@type": "proxyTypeSocks5", username: username ?? "", password: password ?? "" }
      : {
          "@type": "proxyTypeHttp",
          username: username ?? "",
          password: password ?? "",
          http_only: false,
        };
  TdLib.td_json_client_send({ "@type": "addProxy", server, port, enable: true, type });
}

export function requestDisableProxy(): void {
  TdLib.td_json_client_send({ "@type": "disableProxy" });
}

export default TdLib;

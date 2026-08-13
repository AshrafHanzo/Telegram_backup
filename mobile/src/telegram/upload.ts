import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { sendLocalDocumentWithProgress } from "./client";
import { useTransferStore } from "./transferStore";

export interface PickedUpload {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
}

export async function pickDocument(): Promise<PickedUpload | null> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return { uri: asset.uri, name: asset.name, size: asset.size, mimeType: asset.mimeType };
}

export async function pickImage(): Promise<PickedUpload | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error("Photo library permission was denied");

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 1,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  const name = asset.fileName ?? asset.uri.split("/").pop() ?? "photo.jpg";
  return { uri: asset.uri, name, size: asset.fileSize, mimeType: asset.mimeType };
}

// Same upload, but registered with the global transfer store so it shows
// up (with live progress, once TDLib reports a file id for it) in the
// persistent transfer bar.
export function uploadDocumentTracked(chatId: number, picked: PickedUpload): Promise<void> {
  const id = `upload-${chatId}-${picked.name}-${Date.now()}`;
  const store = useTransferStore.getState();
  store.start(id, "upload", picked.name, picked.size ?? 0);
  return sendLocalDocumentWithProgress(chatId, picked.uri, (uploaded, total) => {
    store.progress(id, uploaded, total || undefined);
  }).then(
    () => {
      store.complete(id);
    },
    (error) => {
      store.fail(id, error?.message ?? String(error));
      throw error;
    },
  );
}

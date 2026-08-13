import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Directory, File, Paths } from "expo-file-system";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import { deleteFile, listFiles, moveFiles, renameFile, TelegramFile } from "../telegram/files";
import { downloadFileTracked, shareFile } from "../telegram/download";
import { pickDocument, pickImage, uploadDocumentTracked } from "../telegram/upload";
import { uploadFromUrl } from "../telegram/remoteUpload";
import { closeChat, openChat } from "../telegram/client";
import { listFolders, TelegramFolder } from "../telegram/folders";
import * as vault from "../vault/session";
import { Card, EmptyState, Row } from "../components";
import { colors, radii, spacing, typography } from "../theme";

function isEncryptedFile(name: string): boolean {
  return name.toLowerCase().endsWith(".tdenc");
}

function fileIcon(file: TelegramFile): keyof typeof Ionicons.glyphMap {
  if (isEncryptedFile(file.name)) return "lock-closed";
  if (file.kind === "photo") return "image";
  if (file.kind === "video" || (file.mimeType?.startsWith("video/") ?? false)) return "videocam";
  if (file.name.toLowerCase().endsWith(".zip")) return "archive";
  return "document";
}

function formatSize(size?: number): string | undefined {
  if (!size) return undefined;
  return `${Math.round(size / 1024)} KB`;
}

type Props = NativeStackScreenProps<RootStackParamList, "Files">;

export default function FileListScreen({ route, navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { chatId, title } = route.params;
  const [files, setFiles] = useState<TelegramFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyMessageId, setBusyMessageId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [movingFile, setMovingFile] = useState<TelegramFile | null>(null);
  const [otherFolders, setOtherFolders] = useState<TelegramFolder[]>([]);
  const [urlModalVisible, setUrlModalVisible] = useState(false);
  const [urlValue, setUrlValue] = useState("");

  useEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  useEffect(() => {
    openChat(chatId).catch(() => {});
    return () => {
      closeChat(chatId).catch(() => {});
    };
  }, [chatId]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await listFiles(chatId);
      setFiles(page.files);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  useEffect(() => {
    load();
  }, [load]);

  const onDownload = async (file: TelegramFile) => {
    setBusyMessageId(file.messageId);
    try {
      const localFile = await downloadFileTracked(file.fileId, file.name);
      await shareFile(localFile);
    } catch (e: any) {
      Alert.alert("Download failed", e?.message ?? String(e));
    } finally {
      setBusyMessageId(null);
    }
  };

  const onUpload = async (kind: "document" | "image") => {
    setUploading(true);
    try {
      const picked = kind === "document" ? await pickDocument() : await pickImage();
      if (!picked) return;
      // Progress shows in the persistent transfer bar — fire-and-forget
      // here on purpose, same as before, just now trackable.
      uploadDocumentTracked(chatId, picked).catch((e: any) => {
        Alert.alert("Upload failed", e?.message ?? String(e));
      });
    } catch (e: any) {
      Alert.alert("Upload failed", e?.message ?? String(e));
    } finally {
      setUploading(false);
    }
  };

  const promptUpload = () => {
    Alert.alert("Upload", "Choose a source", [
      { text: "Document", onPress: () => onUpload("document") },
      { text: "Photo", onPress: () => onUpload("image") },
      { text: "From URL", onPress: () => setUrlModalVisible(true) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const onUploadFromUrl = () => {
    const url = urlValue.trim();
    setUrlModalVisible(false);
    setUrlValue("");
    if (!url) return;
    uploadFromUrl(chatId, url).catch((e: any) => {
      Alert.alert("Upload from URL failed", e?.message ?? String(e));
    });
  };

  const startRename = (file: TelegramFile) => {
    setRenamingId(file.messageId);
    setRenameValue(file.name);
  };

  const saveRename = async () => {
    if (renamingId === null) return;
    const messageId = renamingId;
    setBusyMessageId(messageId);
    try {
      await renameFile(chatId, messageId, renameValue.trim());
      setRenamingId(null);
      await load();
    } catch (e: any) {
      Alert.alert("Rename failed", e?.message ?? String(e));
    } finally {
      setBusyMessageId(null);
    }
  };

  const onDelete = (file: TelegramFile) => {
    Alert.alert("Delete file?", file.name, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusyMessageId(file.messageId);
          try {
            await deleteFile(chatId, file.messageId);
            await load();
          } catch (e: any) {
            Alert.alert("Delete failed", e?.message ?? String(e));
          } finally {
            setBusyMessageId(null);
          }
        },
      },
    ]);
  };

  const startMove = async (file: TelegramFile) => {
    try {
      const folders = await listFolders();
      setOtherFolders(folders.filter((f) => f.chatId !== chatId));
      setMovingFile(file);
    } catch (e: any) {
      Alert.alert("Failed to load folders", e?.message ?? String(e));
    }
  };

  const confirmMove = async (destination: TelegramFolder) => {
    if (!movingFile) return;
    const file = movingFile;
    setMovingFile(null);
    setBusyMessageId(file.messageId);
    try {
      const result = await moveFiles(chatId, destination.chatId, [file.messageId]);
      if (result.movedCount < result.requestedCount) {
        Alert.alert(
          "Move incomplete",
          "Couldn't confirm the file arrived, so it was left in place. Try again.",
        );
      }
      await load();
    } catch (e: any) {
      Alert.alert("Move failed", e?.message ?? String(e));
    } finally {
      setBusyMessageId(null);
    }
  };

  const onDecrypt = async (file: TelegramFile) => {
    if (!vault.isUnlocked()) {
      Alert.alert("Vault is locked", "Unlock your vault in Settings first.", [
        { text: "Cancel", style: "cancel" },
        { text: "Go to Vault", onPress: () => navigation.navigate("Vault") },
      ]);
      return;
    }
    setBusyMessageId(file.messageId);
    try {
      const encrypted = await downloadFileTracked(file.fileId, file.name);
      const bytes = await encrypted.bytes();
      const { plaintext, name } = vault.decryptFile(bytes);

      const outDir = new Directory(Paths.cache, "decrypted");
      if (!outDir.exists) outDir.create({ intermediates: true, idempotent: true });
      const outFile = new File(outDir, name);
      if (outFile.exists) outFile.delete();
      outFile.create();
      outFile.write(plaintext);

      await shareFile(outFile);
    } catch (e: any) {
      Alert.alert("Decrypt failed", e?.message ?? String(e));
    } finally {
      setBusyMessageId(null);
    }
  };

  const onFileMenu = (file: TelegramFile) => {
    const options: any[] = [{ text: "Rename", onPress: () => startRename(file) }];
    if (file.name.toLowerCase().endsWith(".zip")) {
      options.push({
        text: "Browse archive",
        onPress: () => navigation.navigate("Archive", { fileId: file.fileId, name: file.name }),
      });
    }
    if (isEncryptedFile(file.name)) {
      options.push({ text: "Decrypt & view", onPress: () => onDecrypt(file) });
    }
    options.push(
      { text: "Move to…", onPress: () => startMove(file) },
      { text: "Delete", style: "destructive", onPress: () => onDelete(file) },
      { text: "Cancel", style: "cancel" },
    );
    Alert.alert(file.name, undefined, options);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        style={styles.list}
        data={files}
        keyExtractor={(item) => String(item.messageId)}
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 96 }]}
        ListEmptyComponent={
          <EmptyState
            icon={<Ionicons name="document-text" size={30} color={colors.info} />}
            title="No files yet"
            description={error ?? "Upload one with the button below."}
            tone="info"
          />
        }
        renderItem={({ item }) =>
          renamingId === item.messageId ? (
            <View style={styles.renameRow}>
              <TextInput
                style={styles.renameInput}
                placeholderTextColor={colors.textTertiary}
                value={renameValue}
                onChangeText={setRenameValue}
                autoFocus
              />
              <Pressable onPress={saveRename} style={styles.renameAction}>
                <Text style={styles.renameActionText}>Save</Text>
              </Pressable>
              <Pressable onPress={() => setRenamingId(null)} style={styles.renameAction}>
                <Text style={styles.renameCancelText}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <Row
              label={item.name}
              hint={formatSize(item.size)}
              icon={
                busyMessageId === item.messageId ? (
                  <ActivityIndicator color={colors.accent} />
                ) : item.minithumbnailData ? (
                  <Image
                    source={{ uri: `data:image/jpeg;base64,${item.minithumbnailData}` }}
                    style={styles.thumbnail}
                  />
                ) : (
                  <View style={styles.fileIcon}>
                    <Ionicons name={fileIcon(item)} size={20} color={colors.accent} />
                  </View>
                )
              }
              onPress={() => {
                if (item.kind === "photo") {
                  navigation.navigate("Preview", { fileId: item.fileId, name: item.name });
                } else if (item.kind === "video" || (item.mimeType?.startsWith("video/") ?? false)) {
                  navigation.navigate("VideoPlayer", { fileId: item.fileId, name: item.name });
                } else {
                  onDownload(item);
                }
              }}
              onLongPress={() => onFileMenu(item)}
              disabled={busyMessageId === item.messageId}
              right={
                <Pressable onPress={() => onFileMenu(item)} style={styles.menuButton}>
                  <Ionicons name="ellipsis-vertical" size={18} color={colors.textSecondary} />
                </Pressable>
              }
            />
          )
        }
      />
      <Pressable
        style={[styles.uploadFab, { bottom: insets.bottom + spacing.lg }]}
        onPress={promptUpload}
        disabled={uploading}
      >
        {uploading ? (
          <ActivityIndicator color={colors.accentContrast} />
        ) : (
          <Ionicons name="add" size={28} color={colors.accentContrast} />
        )}
      </Pressable>

      <Modal visible={movingFile !== null} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <Card raised>
            <Text style={styles.modalTitle}>Move to…</Text>
            {otherFolders.length === 0 && <Text style={styles.hint}>No other folders yet.</Text>}
            {otherFolders.map((folder) => (
              <Pressable
                key={folder.chatId}
                style={styles.modalRow}
                onPress={() => confirmMove(folder)}
              >
                <Text style={styles.modalRowText}>{folder.title}</Text>
              </Pressable>
            ))}
            <Pressable style={styles.modalCancel} onPress={() => setMovingFile(null)}>
              <Text style={styles.renameCancelText}>Cancel</Text>
            </Pressable>
          </Card>
        </View>
      </Modal>

      <Modal visible={urlModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <Card raised>
            <Text style={styles.modalTitle}>Upload from URL</Text>
            <Text style={styles.hint}>
              Fetches the file and sends it straight to this folder — nothing stays on your
              phone afterward.
            </Text>
            <TextInput
              style={styles.input}
              placeholder="https://…"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              keyboardType="url"
              value={urlValue}
              onChangeText={setUrlValue}
            />
            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalCancel}
                onPress={() => {
                  setUrlModalVisible(false);
                  setUrlValue("");
                }}
              >
                <Text style={styles.renameCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.modalCancel} onPress={onUploadFromUrl}>
                <Text style={styles.renameActionText}>Upload</Text>
              </Pressable>
            </View>
          </Card>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.xl },
  hint: { ...typography.metadata, color: colors.textSecondary, textAlign: "center" },
  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  fileIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbnail: { width: 40, height: 40, borderRadius: 10 },
  menuButton: { padding: spacing.sm },
  renameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  renameInput: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    padding: spacing.sm,
    color: colors.text,
  },
  renameAction: { padding: spacing.sm },
  renameActionText: { color: colors.accent, fontWeight: "600" },
  renameCancelText: { color: colors.textSecondary },
  uploadFab: {
    position: "absolute",
    right: spacing.lg,
    bottom: spacing.xl,
    width: 56,
    height: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "center",
    padding: spacing.xl,
  },
  modalTitle: { ...typography.uiEmphasis, color: colors.text, marginBottom: spacing.md },
  input: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    padding: spacing.md,
    color: colors.text,
    marginBottom: spacing.md,
  },
  modalRow: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  modalRowText: { ...typography.ui, color: colors.text },
  modalCancel: { paddingVertical: spacing.md, alignItems: "center" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.md },
});

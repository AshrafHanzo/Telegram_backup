import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import {
  createFolder,
  deleteFolder,
  getFolderInviteLink,
  listFolders,
  renameFolder,
  setFolderPublicUsername,
  TelegramFolder,
} from "../telegram/folders";
import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  NotificationBell,
  Row,
  SearchFabBar,
  TopTabRow,
} from "../components";
import { colors, radii, spacing } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Folders">;

export default function FolderListScreen({ navigation }: Props) {
  const [folders, setFolders] = useState<TelegramFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingVisible, setCreatingVisible] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [busyChatId, setBusyChatId] = useState<number | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<TelegramFolder | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [usernameFolder, setUsernameFolder] = useState<TelegramFolder | null>(null);
  const [usernameValue, setUsernameValue] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await listFolders();
      setFolders(result);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await createFolder(name);
      setNewFolderName("");
      setCreatingVisible(false);
      await load();
    } catch (e: any) {
      Alert.alert("Failed to create folder", e?.message ?? String(e));
    } finally {
      setCreating(false);
    }
  };

  const saveRename = async () => {
    if (!renamingFolder) return;
    const folder = renamingFolder;
    setRenamingFolder(null);
    setBusyChatId(folder.chatId);
    try {
      await renameFolder(folder.chatId, renameValue.trim());
      await load();
    } catch (e: any) {
      Alert.alert("Rename failed", e?.message ?? String(e));
    } finally {
      setBusyChatId(null);
    }
  };

  const onDelete = (folder: TelegramFolder) => {
    Alert.alert("Delete folder?", `"${folder.title}" and everything in it will be deleted.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusyChatId(folder.chatId);
          deleteFolder(folder.supergroupId);
          await new Promise((r) => setTimeout(r, 1500));
          await load();
          setBusyChatId(null);
        },
      },
    ]);
  };

  const onGetInviteLink = async (folder: TelegramFolder) => {
    setBusyChatId(folder.chatId);
    try {
      const link = await getFolderInviteLink(folder.supergroupId);
      setBusyChatId(null);
      if (link) {
        Alert.alert("Invite link", link);
      } else {
        setUsernameValue("");
        setUsernameFolder(folder);
      }
    } catch (e: any) {
      setBusyChatId(null);
      Alert.alert("Failed to get invite link", e?.message ?? String(e));
    }
  };

  const saveUsername = async () => {
    if (!usernameFolder) return;
    const folder = usernameFolder;
    const username = usernameValue.trim();
    setUsernameFolder(null);
    if (!username) return;
    setBusyChatId(folder.chatId);
    try {
      const active = await setFolderPublicUsername(folder.supergroupId, username);
      if (active) {
        Alert.alert("Invite link", `https://t.me/${active}`);
      } else {
        Alert.alert("Couldn't confirm", "The username may already be taken. Try another.");
      }
    } catch (e: any) {
      Alert.alert("Failed to set username", e?.message ?? String(e));
    } finally {
      setBusyChatId(null);
    }
  };

  const onFolderMenu = (folder: TelegramFolder) => {
    Alert.alert(folder.title, undefined, [
      {
        text: "Rename",
        onPress: () => {
          setRenameValue(folder.title.replace(/\s*\[TD\]\s*/i, ""));
          setRenamingFolder(folder);
        },
      },
      { text: "Get invite link", onPress: () => onGetInviteLink(folder) },
      { text: "Delete", style: "destructive", onPress: () => onDelete(folder) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  return (
    <View style={styles.container}>
      <AppHeader
        title="My files"
        trailing={<NotificationBell onPress={() => navigation.navigate("AuditLog")} />}
      />
      <TopTabRow active="myfiles" />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          style={styles.list}
          data={folders}
          keyExtractor={(item) => String(item.chatId)}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={colors.accent} />}
          ListEmptyComponent={
            <EmptyState
              icon={<Ionicons name="folder-open" size={30} color={colors.accent} />}
              title="No folders yet"
              description={error ?? "Create one with the + button below, or from the desktop app."}
              tone="accent"
            />
          }
          renderItem={({ item }) =>
            renamingFolder?.chatId === item.chatId ? (
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
                <Pressable onPress={() => setRenamingFolder(null)} style={styles.renameAction}>
                  <Text style={styles.renameCancelText}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <Row
                label={item.title}
                icon={
                  busyChatId === item.chatId ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : (
                    <View style={styles.folderIcon}>
                      <Ionicons name="folder" size={20} color={colors.accent} />
                    </View>
                  )
                }
                onPress={() => navigation.navigate("Files", { chatId: item.chatId, title: item.title })}
                onLongPress={() => onFolderMenu(item)}
                right={
                  <Pressable onPress={() => onFolderMenu(item)} style={styles.menuButton}>
                    <Ionicons name="ellipsis-vertical" size={18} color={colors.textSecondary} />
                  </Pressable>
                }
              />
            )
          }
        />
      )}

      <SearchFabBar
        placeholder="Search your files"
        onPressSearch={() => navigation.navigate("Search")}
        onPressAdd={() => setCreatingVisible(true)}
      />

      <Modal visible={creatingVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <Card raised>
            <Text style={styles.modalTitle}>New folder</Text>
            <TextInput
              style={styles.input}
              placeholder="Folder name"
              placeholderTextColor={colors.textTertiary}
              value={newFolderName}
              onChangeText={setNewFolderName}
              autoFocus
            />
            <View style={styles.modalActions}>
              <Button
                title="Cancel"
                variant="secondary"
                fullWidth={false}
                onPress={() => {
                  setCreatingVisible(false);
                  setNewFolderName("");
                }}
              />
              <Button title="Create" fullWidth={false} onPress={onCreateFolder} loading={creating} />
            </View>
          </Card>
        </View>
      </Modal>

      <Modal visible={usernameFolder !== null} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <Card raised>
            <Text style={styles.modalTitle}>Set a public username</Text>
            <Text style={styles.hint}>
              A public username is required to mint an invite link for a folder that doesn't
              have one yet.
            </Text>
            <TextInput
              style={styles.input}
              placeholder="username"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              value={usernameValue}
              onChangeText={setUsernameValue}
            />
            <View style={styles.modalActions}>
              <Button title="Cancel" variant="secondary" fullWidth={false} onPress={() => setUsernameFolder(null)} />
              <Button title="Save" fullWidth={false} onPress={saveUsername} />
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
  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  hint: { color: colors.textSecondary, marginBottom: spacing.sm },
  folderIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButton: { padding: spacing.sm },
  input: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    padding: spacing.md,
    color: colors.text,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
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
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "center",
    padding: spacing.xl,
  },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: "600", marginBottom: spacing.sm },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.sm },
});

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { listFolders, TelegramFolder } from "../telegram/folders";
import {
  createShare,
  FolderShareRecord,
  listShares,
  revokeShare,
  SharePermissionBits,
} from "../telegram/shares";
import { AppHeader, Button, EmptyState, Row, ThemedSwitch, TopTabRow } from "../components";
import { colors, radii, spacing, typography } from "../theme";

function permissionsSummary(bits: number): string {
  const labels: string[] = [];
  if (bits & SharePermissionBits.UPLOAD) labels.push("Upload");
  if (bits & SharePermissionBits.DOWNLOAD) labels.push("Download");
  if (bits & SharePermissionBits.UPDATE) labels.push("Update");
  if (bits & SharePermissionBits.DELETE) labels.push("Delete");
  return labels.length > 0 ? labels.join(", ") : "No permissions";
}

export default function ShareLinksScreen() {
  const insets = useSafeAreaInsets();
  const [folders, setFolders] = useState<TelegramFolder[]>([]);
  const [shares, setShares] = useState<FolderShareRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFolder, setSelectedFolder] = useState<TelegramFolder | null>(null);
  const [canUpload, setCanUpload] = useState(false);
  const [canDownload, setCanDownload] = useState(true);
  const [canUpdate, setCanUpdate] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [folderList, shareList] = await Promise.all([listFolders(), listShares()]);
      setFolders(folderList);
      setShares(shareList);
    } catch (e: any) {
      Alert.alert("Failed to load", e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onCreate = async () => {
    if (!selectedFolder) {
      Alert.alert("Pick a folder first");
      return;
    }
    let permissions = 0;
    if (canUpload) permissions |= SharePermissionBits.UPLOAD;
    if (canDownload) permissions |= SharePermissionBits.DOWNLOAD;
    if (canUpdate) permissions |= SharePermissionBits.UPDATE;
    if (canDelete) permissions |= SharePermissionBits.DELETE;
    if (permissions === 0) {
      Alert.alert("Pick at least one permission");
      return;
    }

    setCreating(true);
    try {
      await createShare({
        folderId: selectedFolder.chatId,
        folderName: selectedFolder.title,
        permissions,
      });
      await load();
      Alert.alert(
        "Link created",
        "This link only works while your desktop app is running to serve it.",
      );
    } catch (e: any) {
      Alert.alert("Failed to create link", e?.message ?? String(e));
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (id: string) => {
    try {
      await revokeShare(id);
      await load();
    } catch (e: any) {
      Alert.alert("Failed to revoke", e?.message ?? String(e));
    }
  };

  return (
    <View style={styles.container}>
      <AppHeader title="Shared" />
      <TopTabRow active="shared" />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        >
          <Text style={styles.hint}>
            Links only work while your desktop app is running to serve them. This screen manages
            the list; it doesn't host anything itself.
          </Text>

          <Text style={styles.sectionTitle}>Existing links</Text>
          {shares.length === 0 && (
            <EmptyState
              icon={<Ionicons name="link" size={30} color={colors.success} />}
              title="No links yet"
              description="Create one below from any of your folders."
              tone="success"
            />
          )}
          {shares.map((share) => (
            <Row
              key={share.id}
              label={share.folder_name}
              hint={`${permissionsSummary(share.permissions)} · ${share.revoked ? "Revoked" : "Active"}`}
              icon={<Ionicons name="link" size={20} color={colors.accent} />}
              dimmed={share.revoked}
              right={
                !share.revoked ? (
                  <Pressable onPress={() => onRevoke(share.id)} style={styles.revokeButton}>
                    <Text style={styles.revokeButtonText}>Revoke</Text>
                  </Pressable>
                ) : undefined
              }
            />
          ))}

          <Text style={styles.sectionTitle}>Create new link</Text>
          {folders.length === 0 ? (
            <Text style={styles.hint}>No folders available yet.</Text>
          ) : (
            folders.map((folder) => (
              <Pressable
                key={folder.chatId}
                style={[
                  styles.folderRow,
                  selectedFolder?.chatId === folder.chatId && styles.folderRowSelected,
                ]}
                onPress={() => setSelectedFolder(folder)}
              >
                <Text style={styles.folderRowText}>{folder.title}</Text>
              </Pressable>
            ))
          )}

          <View style={styles.permissionRow}>
            <Text style={styles.permissionLabel}>Upload</Text>
            <ThemedSwitch value={canUpload} onValueChange={setCanUpload} />
          </View>
          <View style={styles.permissionRow}>
            <Text style={styles.permissionLabel}>Download</Text>
            <ThemedSwitch value={canDownload} onValueChange={setCanDownload} />
          </View>
          <View style={styles.permissionRow}>
            <Text style={styles.permissionLabel}>Update</Text>
            <ThemedSwitch value={canUpdate} onValueChange={setCanUpdate} />
          </View>
          <View style={styles.permissionRow}>
            <Text style={styles.permissionLabel}>Delete</Text>
            <ThemedSwitch value={canDelete} onValueChange={setCanDelete} />
          </View>

          <View style={styles.createButtonWrap}>
            <Button title="Create link" onPress={onCreate} loading={creating} />
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.lg },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textTertiary,
    textTransform: "uppercase",
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  revokeButton: { padding: spacing.sm },
  revokeButtonText: { color: colors.danger, fontWeight: "600" },
  folderRow: {
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    backgroundColor: colors.surfaceRaised,
    marginBottom: spacing.sm,
  },
  folderRowSelected: { borderColor: colors.accent, backgroundColor: colors.selected },
  folderRowText: { ...typography.ui, color: colors.text },
  permissionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  permissionLabel: { ...typography.ui, color: colors.text },
  createButtonWrap: { marginTop: spacing.lg },
});

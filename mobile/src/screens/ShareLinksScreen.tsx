import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { listFolders, TelegramFolder } from "../telegram/folders";
import {
  createShare,
  listShares,
  revokeShare,
  SharePermissionBits,
  type ShareListing,
} from "../telegram/shares";
import {
  AppHeader,
  Button,
  EmptyState,
  NoticeCard,
  Row,
  TextField,
  ThemedSwitch,
  TopTabRow,
} from "../components";
import { colors, radii, spacing, typography } from "../theme";

/// Same presets the desktop app offers (SharePasswordAndExpiryFields.tsx).
type ExpiryChoice = "never" | "1h" | "1d" | "7d";

const EXPIRY_OPTIONS: { value: ExpiryChoice; label: string; hours: number | null }[] = [
  { value: "never", label: "Never", hours: null },
  { value: "1h", label: "1 hour", hours: 1 },
  { value: "1d", label: "1 day", hours: 24 },
  { value: "7d", label: "7 days", hours: 24 * 7 },
];

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
  const [listing, setListing] = useState<ShareListing>({ publication: null, items: [] });
  const [loading, setLoading] = useState(true);
  const [selectedFolder, setSelectedFolder] = useState<TelegramFolder | null>(null);
  const [canUpload, setCanUpload] = useState(false);
  const [canDownload, setCanDownload] = useState(true);
  const [canUpdate, setCanUpdate] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [creating, setCreating] = useState(false);
  /// Tokens requested this session that desktop hasn't published yet. They
  /// have no link to show until it does, so they're listed separately rather
  /// than pretending to be live shares.
  const [awaitingIds, setAwaitingIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const [folderList, shareListing] = await Promise.all([listFolders(), listShares()]);
      setFolders(folderList);
      setListing(shareListing);
      // Anything desktop has now published is no longer pending.
      const published = new Set(shareListing.items.map((item) => item.share.id));
      setAwaitingIds((pending) => pending.filter((id) => !published.has(id)));
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

    const hours = EXPIRY_OPTIONS.find((option) => option.value === expiry)?.hours ?? null;

    setCreating(true);
    try {
      const shareId = await createShare({
        // `supergroupId`, NOT `chatId`: the desktop app matches folders on the
        // raw channel id, so sending the TDLib `-100…` chat id would create a
        // share it could never serve. That mismatch is why this screen's
        // links never worked before.
        folderId: selectedFolder.supergroupId,
        folderName: selectedFolder.title,
        permissions,
        password: password || undefined,
        username: username || undefined,
        expiresAt: hours ? Math.floor(Date.now() / 1000) + hours * 3600 : undefined,
      });
      setAwaitingIds((pending) => [...pending, shareId]);
      setPassword("");
      setUsername("");
      await load();
      Alert.alert(
        "Request sent",
        "Your desktop app will create this link the next time it's open and focused. Pull down to refresh once it has.",
      );
    } catch (e: any) {
      Alert.alert("Failed to request link", e?.message ?? String(e));
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (id: string) => {
    try {
      await revokeShare(id);
      Alert.alert(
        "Revoke requested",
        "The link stops working once your desktop app picks this up.",
      );
      await load();
    } catch (e: any) {
      Alert.alert("Failed to revoke", e?.message ?? String(e));
    }
  };

  const onShareLink = async (link: string) => {
    try {
      await Share.share({ message: link });
    } catch (e: any) {
      Alert.alert("Couldn't share", e?.message ?? String(e));
    }
  };

  const publication = listing.publication;

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
            Your desktop app is what actually serves these links, so it has to be running for them
            to work. Requests you make here are picked up the next time it's open.
          </Text>

          {publication && !publication.public && (
            <NoticeCard
              icon={<Ionicons name="cloud-offline-outline" size={22} color={colors.warning} />}
              title="No public address yet"
              description="Your desktop app is reachable only on its own machine right now, so links can't be opened from elsewhere. They'll appear here once its public tunnel connects."
            />
          )}
          {!publication && (
            <NoticeCard
              icon={<Ionicons name="desktop-outline" size={22} color={colors.warning} />}
              title="Waiting for your desktop app"
              description="It hasn't published a share list yet. Open the desktop app once, then pull down to refresh."
            />
          )}

          <Text style={styles.sectionTitle}>Existing links</Text>
          {listing.items.length === 0 && awaitingIds.length === 0 && (
            <EmptyState
              icon={<Ionicons name="link" size={30} color={colors.success} />}
              title="No links yet"
              description="Create one below from any of your folders."
              tone="success"
            />
          )}

          {listing.items.map(({ share, link }) => (
            <View key={share.id} style={styles.shareCard}>
              <Row
                label={share.folder_name}
                hint={`${permissionsSummary(share.permissions)}${share.has_password ? " · Password" : ""}`}
                icon={<Ionicons name="link" size={20} color={colors.accent} />}
                right={
                  <Pressable onPress={() => onRevoke(share.id)} style={styles.revokeButton}>
                    <Text style={styles.revokeButtonText}>Revoke</Text>
                  </Pressable>
                }
              />
              {link ? (
                <View style={styles.linkBlock}>
                  <Text style={styles.linkText} selectable numberOfLines={2}>
                    {link}
                  </Text>
                  <Pressable onPress={() => onShareLink(link)} style={styles.shareButton}>
                    <Ionicons name="share-outline" size={16} color={colors.accent} />
                    <Text style={styles.shareButtonText}>Share</Text>
                  </Pressable>
                </View>
              ) : (
                <Text style={styles.linkUnavailable}>
                  Waiting for your desktop app's public address
                </Text>
              )}
            </View>
          ))}

          {awaitingIds.map((id) => (
            <Row
              key={id}
              label="Requested link"
              hint="Waiting for your desktop app to create it"
              icon={<Ionicons name="time-outline" size={20} color={colors.textTertiary} />}
              dimmed
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

          <Text style={styles.sectionTitle}>Protection</Text>
          <TextField
            label="Password (optional)"
            placeholder="Leave empty for no password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
          />
          <TextField
            label="Username (optional)"
            placeholder="Requires a password"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
          />

          <Text style={styles.sectionTitle}>Expires</Text>
          <View style={styles.expiryRow}>
            {EXPIRY_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => setExpiry(option.value)}
                style={[styles.expiryChip, expiry === option.value && styles.expiryChipSelected]}
              >
                <Text
                  style={[
                    styles.expiryChipText,
                    expiry === option.value && styles.expiryChipTextSelected,
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.createButtonWrap}>
            <Button title="Request link" onPress={onCreate} loading={creating} />
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
  shareCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    marginBottom: spacing.sm,
    overflow: "hidden",
  },
  linkBlock: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  linkText: { ...typography.metadata, color: colors.accent, flex: 1 },
  shareButton: { flexDirection: "row", alignItems: "center", gap: spacing.xs, padding: spacing.sm },
  shareButtonText: { ...typography.metadata, color: colors.accent, fontWeight: "600" },
  linkUnavailable: {
    ...typography.metadata,
    color: colors.textTertiary,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
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
  expiryRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  expiryChip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    backgroundColor: colors.surfaceRaised,
  },
  expiryChipSelected: { borderColor: colors.accent, backgroundColor: colors.selected },
  expiryChipText: { ...typography.metadata, color: colors.textSecondary },
  expiryChipTextSelected: { color: colors.accent, fontWeight: "600" },
  createButtonWrap: { marginTop: spacing.lg },
});

import { useCallback, useEffect, useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import * as backup from "../backup/backup";
import * as backgroundTask from "../backup/backgroundTask";
import { runRestore } from "../backup/restore";
import { createFolder, listFolders, TelegramFolder } from "../telegram/folders";
import { Button, ScreenContainer, ThemedSwitch } from "../components";
import { colors, radii, spacing, typography } from "../theme";

export default function BackupScreen() {
  const [sourceUri, setSourceUri] = useState<string | null>(null);
  const [destination, setDestination] = useState<backup.BackupDestination | null>(null);
  const [folders, setFolders] = useState<TelegramFolder[]>([]);
  const [newFolderName, setNewFolderName] = useState("");
  const [autoBackup, setAutoBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [source, dest, folderList, registered] = await Promise.all([
      backup.getSource(),
      backup.getDestination(),
      listFolders(),
      backgroundTask.isDailyBackupRegistered(),
    ]);
    setSourceUri(source);
    setDestination(dest);
    setFolders(folderList);
    setAutoBackup(registered);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onPickSource = async () => {
    try {
      const uri = await backup.pickSource();
      setSourceUri(uri);
    } catch (e: any) {
      Alert.alert("Failed to pick folder", e?.message ?? String(e));
    }
  };

  const onSelectDestination = async (folder: TelegramFolder) => {
    await backup.setDestination({ chatId: folder.chatId, name: folder.title });
    setDestination({ chatId: folder.chatId, name: folder.title });
  };

  const onCreateDestination = async () => {
    if (!newFolderName.trim()) return;
    setBusy(true);
    try {
      const folder = await createFolder(newFolderName.trim());
      await backup.setDestination({ chatId: folder.chatId, name: folder.title });
      setDestination({ chatId: folder.chatId, name: folder.title });
      setNewFolderName("");
      await load();
    } catch (e: any) {
      Alert.alert("Failed to create folder", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const onBackupNow = async () => {
    setBusy(true);
    setStatus("Backing up…");
    try {
      const result = await backup.runBackup((progress) => {
        setStatus(`Backing up ${progress.completed}/${progress.total}: ${progress.current ?? ""}`);
      });
      setStatus(
        `Done. Uploaded ${result.uploaded}, skipped ${result.skipped}, failed ${result.failed}.`,
      );
    } catch (e: any) {
      setStatus(null);
      Alert.alert("Backup failed", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async () => {
    if (!sourceUri || !destination) {
      Alert.alert("Pick a folder and destination first");
      return;
    }
    setBusy(true);
    setStatus("Restoring…");
    try {
      const result = await runRestore(sourceUri, destination.chatId, (progress) => {
        setStatus(`Restoring: ${progress.current}`);
      });
      setStatus(`Done. Downloaded ${result.downloaded}, failed ${result.failed}.`);
    } catch (e: any) {
      setStatus(null);
      Alert.alert("Restore failed", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const onToggleAutoBackup = async (value: boolean) => {
    setAutoBackup(value);
    try {
      if (value) {
        await backgroundTask.registerDailyBackup();
      } else {
        await backgroundTask.unregisterDailyBackup();
      }
    } catch (e: any) {
      setAutoBackup(!value);
      Alert.alert("Failed to change auto-backup", e?.message ?? String(e));
    }
  };

  return (
    <ScreenContainer scroll>
      <Text style={styles.title}>Backup & Restore</Text>

      <Text style={styles.sectionTitle}>Local folder</Text>
      <Text style={styles.hint}>{sourceUri ?? "No folder selected yet."}</Text>
      <Button title="Choose folder" variant="secondary" onPress={onPickSource} />

      <Text style={styles.sectionTitle}>Destination Telegram folder</Text>
      <Text style={styles.hint}>{destination ? destination.name : "None selected yet."}</Text>
      {folders.map((folder) => (
        <View key={folder.chatId} style={styles.folderButtonSpacer}>
          <Button
            title={folder.title}
            variant={destination?.chatId === folder.chatId ? "primary" : "secondary"}
            onPress={() => onSelectDestination(folder)}
          />
        </View>
      ))}
      <View style={styles.newFolderRow}>
        <TextInput
          style={styles.input}
          placeholder="New folder name"
          placeholderTextColor={colors.textTertiary}
          value={newFolderName}
          onChangeText={setNewFolderName}
        />
        <Button title="Create" onPress={onCreateDestination} disabled={busy} />
      </View>

      <Text style={styles.sectionTitle}>Auto-backup</Text>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Best-effort daily background backup</Text>
        <ThemedSwitch value={autoBackup} onValueChange={onToggleAutoBackup} />
      </View>

      <View style={styles.actions}>
        <Button title="Backup Now" onPress={onBackupNow} disabled={busy} />
        <View style={styles.spacer} />
        <Button title="Restore" onPress={onRestore} disabled={busy} variant="destructive" />
      </View>

      {status && <Text style={styles.status}>{status}</Text>}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text, marginBottom: spacing.sm },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textTertiary,
    textTransform: "uppercase",
    marginTop: spacing.xl,
    marginBottom: spacing.xs,
  },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.sm },
  folderButtonSpacer: { marginBottom: spacing.sm },
  newFolderRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    padding: spacing.md,
    color: colors.text,
  },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  switchLabel: { ...typography.ui, color: colors.text, flexShrink: 1, marginRight: spacing.sm },
  actions: { marginTop: spacing.xl },
  spacer: { height: spacing.md },
  status: { ...typography.metadata, marginTop: spacing.lg, color: colors.textSecondary, textAlign: "center" },
});

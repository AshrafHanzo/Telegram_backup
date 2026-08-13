import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as vault from "../vault/session";
import { AppHeader, Button, EmptyState, TextField, TopTabRow } from "../components";
import { colors, spacing, typography } from "../theme";

export default function VaultScreen() {
  const insets = useSafeAreaInsets();
  const [passphrase, setPassphrase] = useState("");
  const [vaultFileName, setVaultFileName] = useState<string | null>(null);
  const [vaultFileUri, setVaultFileUri] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(vault.isUnlocked());
  const [busy, setBusy] = useState(false);

  const onImport = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    setVaultFileUri(asset.uri);
    setVaultFileName(asset.name);
  };

  const onUnlock = async () => {
    if (!vaultFileUri) {
      Alert.alert("Import your desktop .vault file first");
      return;
    }
    setBusy(true);
    try {
      const bytes = await new File(vaultFileUri).bytes();
      await vault.unlock(bytes, passphrase);
      setUnlocked(true);
      setPassphrase("");
    } catch (e: any) {
      Alert.alert("Unlock failed", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const onLock = () => {
    vault.lock();
    setUnlocked(false);
  };

  return (
    <View style={styles.container}>
      <AppHeader title="Vault" />
      <TopTabRow active="vault" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
      >
        {!vaultFileName ? (
          <EmptyState
            icon={<Ionicons name="shield-checkmark" size={30} color={colors.warning} />}
            title="Set up your vault"
            description="Transfer your desktop app's .vault file to your phone (email, cloud storage, USB) and import it here to decrypt files on the go. Mobile is read-only — it never encrypts new files into the vault."
            actionLabel="Import .vault file"
            onAction={onImport}
            tone="warning"
          />
        ) : (
          <>
            <Text style={styles.hint}>
              Read-only on mobile: this can decrypt files your desktop app already encrypted, but
              mobile never encrypts new files into the vault. Nothing here is written back
              anywhere — the unlocked key only lives in memory and clears when you lock or close
              the app.
            </Text>

            <Text style={styles.sectionTitle}>Vault file</Text>
            <Text style={styles.hint}>{vaultFileName}</Text>
            <Button title="Import a different file" variant="secondary" fullWidth={false} onPress={onImport} />

            <Text style={styles.sectionTitle}>Status: {unlocked ? "Unlocked" : "Locked"}</Text>

            {unlocked ? (
              <Button title="Lock" variant="destructive" fullWidth={false} onPress={onLock} />
            ) : (
              <>
                <TextField
                  placeholder="Vault passphrase"
                  secureTextEntry
                  value={passphrase}
                  onChangeText={setPassphrase}
                />
                <Button title="Unlock" onPress={onUnlock} loading={busy} />
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.lg },
  sectionTitle: { ...typography.uiEmphasis, color: colors.text, marginTop: spacing.lg, marginBottom: spacing.sm },
});

import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { loadCredentials, saveCredentials } from "../telegram/credentials";
import { startClient } from "../telegram/client";
import { Button, ScreenContainer } from "../components";
import { colors, radii, spacing, typography } from "../theme";

export default function CredentialsScreen() {
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadCredentials().then((creds) => {
      if (creds) {
        setApiId(String(creds.apiId));
        setApiHash(creds.apiHash);
      }
      setLoading(false);
    });
  }, []);

  const onSave = async () => {
    const id = Number(apiId.trim());
    const hash = apiHash.trim();
    if (!Number.isFinite(id) || id <= 0 || !hash) {
      Alert.alert("Enter a valid API ID and API hash");
      return;
    }
    setBusy(true);
    try {
      const creds = { apiId: id, apiHash: hash };
      await saveCredentials(creds);
      await startClient(creds);
      Alert.alert("Saved", "Reconnected with the new credentials.");
    } catch (e: any) {
      Alert.alert("Failed to reconnect", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScreenContainer>
      <Text style={styles.title}>Telegram API Credentials</Text>
      <Text style={styles.hint}>Get these from my.telegram.org/apps</Text>

      <Text style={styles.label}>API ID</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.textTertiary}
        value={apiId}
        onChangeText={setApiId}
        keyboardType="number-pad"
      />

      <Text style={styles.label}>API Hash</Text>
      <View style={styles.hashRow}>
        <TextInput
          style={[styles.input, styles.hashInput]}
          placeholderTextColor={colors.textTertiary}
          value={apiHash}
          onChangeText={setApiHash}
          secureTextEntry={!revealed}
          autoCapitalize="none"
        />
        <Button title={revealed ? "Hide" : "Show"} variant="secondary" onPress={() => setRevealed(!revealed)} />
      </View>

      <Button title="Save & Reconnect" onPress={onSave} loading={busy} />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.canvas },
  title: { ...typography.title, color: colors.text, marginBottom: spacing.xs },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.xl },
  label: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    padding: spacing.md,
    color: colors.text,
    marginBottom: spacing.lg,
  },
  hashRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  hashInput: { flex: 1 },
});

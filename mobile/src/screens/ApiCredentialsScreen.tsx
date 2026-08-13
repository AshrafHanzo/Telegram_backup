import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useAuthStore } from "../telegram/authStore";
import { Button, ScreenContainer, TextField } from "../components";
import { colors, spacing, typography } from "../theme";
import * as googleSignin from "../google/signin";
import * as drive from "../google/drive";

export default function ApiCredentialsScreen() {
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const setCredentials = useAuthStore((s) => s.setCredentials);
  const submitting = useAuthStore((s) => s.submitting);
  const storeError = useAuthStore((s) => s.error);

  const onSubmit = () => {
    const id = Number(apiId.trim());
    const hash = apiHash.trim();
    if (!Number.isFinite(id) || id <= 0) {
      setLocalError("Enter a valid numeric API ID");
      return;
    }
    if (hash.length === 0) {
      setLocalError("Enter your API hash");
      return;
    }
    setLocalError(null);
    setCredentials({ apiId: id, apiHash: hash });
  };

  // Signs in with Google and pulls api_id/api_hash from the same Drive
  // appdata blob the desktop app reads/writes — a faster path in than
  // hunting down my.telegram.org credentials again on a second device.
  // Unlike desktop, this can't also restore a full logged-in session: that
  // relies on desktop's own grammers session file format plus a TOTP-keyed
  // decryption step, and TDLib has no way to import a session from a
  // different Telegram client library — phone/code (or 2FA) login still
  // has to happen on this device regardless.
  const onContinueWithGoogle = async () => {
    setLocalError(null);
    setGoogleBusy(true);
    try {
      await googleSignin.signIn();
      const payload = await drive.pull();
      if (!payload?.api_id || !payload?.api_hash) {
        Alert.alert(
          "No credentials found",
          "Your Google account is signed in, but no Telegram API credentials were found in Drive yet. Enter them below once, and they'll sync for next time.",
        );
        return;
      }
      const id = Number(payload.api_id);
      if (!Number.isFinite(id) || id <= 0) {
        Alert.alert("Couldn't read credentials", "The synced API ID wasn't a valid number.");
        return;
      }
      setCredentials({ apiId: id, apiHash: payload.api_hash });
    } catch (e: any) {
      Alert.alert("Google sign-in failed", e?.message ?? String(e));
    } finally {
      setGoogleBusy(false);
    }
  };

  return (
    <ScreenContainer centered>
      <Text style={styles.title}>Telegram API Credentials</Text>
      <Text style={styles.hint}>Get these from my.telegram.org/apps</Text>
      <TextField
        placeholder="API ID"
        keyboardType="number-pad"
        value={apiId}
        onChangeText={setApiId}
      />
      <TextField
        placeholder="API Hash"
        autoCapitalize="none"
        value={apiHash}
        onChangeText={setApiHash}
      />
      {(localError || storeError) && <Text style={styles.error}>{localError ?? storeError}</Text>}
      <Button title="Continue" onPress={onSubmit} loading={submitting} />

      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerLine} />
      </View>
      <Button
        title="Continue with Google"
        variant="secondary"
        onPress={onContinueWithGoogle}
        loading={googleBusy}
      />
      <Text style={styles.googleHint}>
        Fills these in automatically if you've already linked Google on another device.
      </Text>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text, marginBottom: spacing.xs },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.lg },
  error: { color: colors.danger, marginBottom: spacing.md },
  dividerRow: { flexDirection: "row", alignItems: "center", marginVertical: spacing.lg, gap: spacing.sm },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.borderSubtle },
  dividerText: { ...typography.metadata, color: colors.textTertiary },
  googleHint: { ...typography.metadata, color: colors.textTertiary, textAlign: "center", marginTop: spacing.sm },
});

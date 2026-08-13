import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as appLock from "../security/appLock";
import AppLockSetupFlow from "./AppLockSetupFlow";
import { Button, ScreenContainer, TextField } from "../components";
import { colors, spacing, typography } from "../theme";

interface Props {
  email: string | null;
  onUnlock: () => void;
}

export default function AppLockScreen({ email, onUnlock }: Props) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const triedAutoPrompt = useRef(false);

  const tryBiometric = useCallback(async () => {
    setError(null);
    try {
      if (await appLock.authenticateWithBiometric()) {
        onUnlock();
      }
    } catch {
      // Sensor error or cancelled — the password field is always right there.
    }
  }, [onUnlock]);

  useEffect(() => {
    appLock.isBiometricEnabled().then((enabled) => {
      setBiometricAvailable(enabled);
      // Prompt automatically once per screen mount (i.e. once per app open/
      // lock), same as the OS's own biometric unlock convention — but never
      // re-trigger itself just because state re-rendered.
      if (enabled && !triedAutoPrompt.current) {
        triedAutoPrompt.current = true;
        tryBiometric();
      }
    });
  }, [tryBiometric]);

  if (resetting) {
    return (
      <AppLockSetupFlow
        mode="reset"
        initialEmail={email}
        onComplete={onUnlock}
        onCancel={() => setResetting(false)}
      />
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const ok = await appLock.verifyCurrentPassword(password);
      if (ok) {
        onUnlock();
      } else {
        setError("Incorrect password");
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer centered>
      <Text style={styles.title}>App Locked</Text>
      {email && <Text style={styles.hint}>{email}</Text>}
      <TextField
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        onSubmitEditing={submit}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Button title="Unlock" onPress={submit} loading={busy} />
      {biometricAvailable && (
        <View style={styles.spacer}>
          <Button title="Use Fingerprint" variant="secondary" onPress={tryBiometric} />
        </View>
      )}
      <View style={styles.spacer}>
        <Button title="Forgot password?" variant="ghost" onPress={() => setResetting(true)} />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text, marginBottom: spacing.sm, textAlign: "center" },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.lg, textAlign: "center" },
  error: { color: colors.danger, marginBottom: spacing.md, textAlign: "center" },
  spacer: { marginTop: spacing.sm },
});

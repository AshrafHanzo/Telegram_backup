import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as appLock from "../security/appLock";
import { sendSelfOtp, verifySelfOtp } from "../telegram/selfMessage";
import { Button, ScreenContainer, TextField } from "../components";
import { colors, spacing, typography } from "../theme";

type SubStep = "confirm" | "otp" | "password";

interface Props {
  initialEmail?: string | null;
  mode?: "setup" | "reset";
  onComplete: () => void;
  onCancel?: () => void;
}

export default function AppLockSetupFlow({
  initialEmail,
  mode = "setup",
  onComplete,
  onCancel,
}: Props) {
  const [subStep, setSubStep] = useState<SubStep>("confirm");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendSelfOtp();
      setSubStep("otp");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const ok = await verifySelfOtp(code.trim());
      if (!ok) {
        setError("That code is incorrect or expired.");
        return;
      }
      setSubStep("password");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async () => {
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await appLock.setPassword(email.trim(), password);
      onComplete();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer>
      <Text style={styles.title}>{mode === "reset" ? "Reset App Lock" : "Set up App Lock"}</Text>

      {subStep === "confirm" && (
        <>
          <Text style={styles.hint}>
            We'll send a verification code to your Telegram Saved Messages to confirm it's you.
          </Text>
          <TextField
            placeholder="Label this lock with an email (optional)"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
        </>
      )}

      {subStep === "otp" && (
        <>
          <Text style={styles.hint}>Check your Telegram Saved Messages for the code.</Text>
          <TextField
            placeholder="6-digit code"
            keyboardType="number-pad"
            value={code}
            onChangeText={setCode}
          />
        </>
      )}

      {subStep === "password" && (
        <>
          <TextField
            placeholder="New password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
          <TextField
            placeholder="Confirm password"
            secureTextEntry
            value={confirmPassword}
            onChangeText={setConfirmPassword}
          />
        </>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {subStep === "confirm" && <Button title="Send code" onPress={sendCode} loading={busy} />}
      {subStep === "otp" && <Button title="Verify" onPress={verifyCode} loading={busy} />}
      {subStep === "password" && <Button title="Save password" onPress={savePassword} loading={busy} />}
      {onCancel && !busy && (
        <View style={styles.spacer}>
          <Button title="Cancel" variant="ghost" onPress={onCancel} />
        </View>
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text, marginBottom: spacing.sm },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.lg },
  error: { color: colors.danger, marginBottom: spacing.md },
  spacer: { marginTop: spacing.sm },
});

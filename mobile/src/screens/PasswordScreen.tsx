import { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { useAuthStore } from "../telegram/authStore";
import { Button, ScreenContainer, TextField } from "../components";
import { colors, spacing, typography } from "../theme";

export default function PasswordScreen() {
  const [password, setPassword] = useState("");
  const submitPassword = useAuthStore((s) => s.submitPassword);
  const submitting = useAuthStore((s) => s.submitting);
  const error = useAuthStore((s) => s.error);

  return (
    <ScreenContainer centered>
      <Text style={styles.title}>Two-step verification</Text>
      <Text style={styles.hint}>Enter your Telegram cloud password.</Text>
      <TextField
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Button title="Verify" loading={submitting} onPress={() => submitPassword(password)} />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text, marginBottom: spacing.xs },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.lg },
  error: { color: colors.danger, marginBottom: spacing.md },
});

import { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { useAuthStore } from "../telegram/authStore";
import { Button, ScreenContainer, TextField } from "../components";
import { colors, spacing, typography } from "../theme";

export default function CodeScreen() {
  const [code, setCode] = useState("");
  const submitCode = useAuthStore((s) => s.submitCode);
  const submitting = useAuthStore((s) => s.submitting);
  const error = useAuthStore((s) => s.error);

  return (
    <ScreenContainer centered>
      <Text style={styles.title}>Enter the code</Text>
      <Text style={styles.hint}>Telegram sent you a login code via SMS or another session.</Text>
      <TextField
        placeholder="Login code"
        keyboardType="number-pad"
        value={code}
        onChangeText={setCode}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Button title="Verify" loading={submitting} onPress={() => submitCode(code.trim())} />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text, marginBottom: spacing.xs },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.lg },
  error: { color: colors.danger, marginBottom: spacing.md },
});

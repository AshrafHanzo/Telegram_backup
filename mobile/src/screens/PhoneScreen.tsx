import { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { useAuthStore } from "../telegram/authStore";
import { Button, ScreenContainer, TextField } from "../components";
import { colors, spacing, typography } from "../theme";

export default function PhoneScreen() {
  const [countryCode, setCountryCode] = useState("+1");
  const [phoneNumber, setPhoneNumber] = useState("");
  const submitPhone = useAuthStore((s) => s.submitPhone);
  const submitting = useAuthStore((s) => s.submitting);
  const error = useAuthStore((s) => s.error);

  return (
    <ScreenContainer centered>
      <Text style={styles.title}>Sign in to Telegram</Text>
      <TextField
        placeholder="Country code (e.g. +1)"
        value={countryCode}
        onChangeText={setCountryCode}
      />
      <TextField
        placeholder="Phone number"
        keyboardType="phone-pad"
        value={phoneNumber}
        onChangeText={setPhoneNumber}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Button
        title="Send code"
        loading={submitting}
        onPress={() => submitPhone(countryCode.trim(), phoneNumber.trim())}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text, marginBottom: spacing.lg },
  error: { color: colors.danger, marginBottom: spacing.md },
});

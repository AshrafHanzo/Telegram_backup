import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAuthStore } from "../telegram/authStore";
import { colors, spacing, typography } from "../theme";
import { Button, LoadingScreen } from "../components";
import ApiCredentialsScreen from "./ApiCredentialsScreen";
import PhoneScreen from "./PhoneScreen";
import CodeScreen from "./CodeScreen";
import PasswordScreen from "./PasswordScreen";

export default function AuthFlowScreen() {
  const kind = useAuthStore((s) => s.kind);
  const unsupportedType = useAuthStore((s) => s.unsupportedType);
  const error = useAuthStore((s) => s.error);
  const init = useAuthStore((s) => s.init);

  useEffect(() => {
    init();
  }, [init]);

  switch (kind) {
    case "needsCredentials":
      return <ApiCredentialsScreen />;
    case "waitPhoneNumber":
      return <PhoneScreen />;
    case "waitCode":
      return <CodeScreen />;
    case "waitPassword":
      return <PasswordScreen />;
    case "unsupported":
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Unsupported sign-in step</Text>
          <Text style={styles.hint}>
            Telegram is asking for "{unsupportedType}", which this app doesn't handle yet.
          </Text>
        </View>
      );
    case "closed":
      // Once the restart itself has failed (see authStore's swallowed-error
      // fix), keep showing the error instead of the spinner forever, with a
      // way to retry rather than leaving the user stuck with no recourse.
      return error ? (
        <View style={styles.container}>
          <Text style={styles.title}>Couldn't restart Telegram</Text>
          <Text style={styles.hint}>{error}</Text>
          <View style={styles.retryButton}>
            <Button title="Retry" onPress={init} />
          </View>
        </View>
      ) : (
        <LoadingScreen showSpinner message="Restarting Telegram client…" />
      );
    default:
      return <LoadingScreen />;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: spacing.xl,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.canvas,
  },
  title: { ...typography.title, color: colors.text, marginBottom: spacing.sm, textAlign: "center" },
  hint: { ...typography.metadata, color: colors.textSecondary, textAlign: "center", marginTop: spacing.sm },
  retryButton: { marginTop: spacing.lg },
});

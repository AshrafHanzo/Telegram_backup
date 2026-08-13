import { ActivityIndicator, Image, StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "../theme";

interface Props {
  showSpinner?: boolean;
  message?: string;
}

// Matches the reference app's splash screen exactly: pure black, nothing
// but the app mark centered. Used for the initial auth-check/loading state,
// not just the native cold-launch splash (see app.json's expo-splash-screen
// plugin for that one).
export default function LoadingScreen({ showSpinner = false, message }: Props) {
  return (
    <View style={styles.container}>
      <Image source={require("../../assets/icon.png")} style={styles.logo} resizeMode="contain" />
      {showSpinner && <ActivityIndicator color={colors.accent} style={styles.spinner} />}
      {message && <Text style={styles.message}>{message}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas, alignItems: "center", justifyContent: "center" },
  logo: { width: 120, height: 120, borderRadius: 24 },
  spinner: { marginTop: spacing.xl },
  message: { ...typography.metadata, color: colors.textSecondary, marginTop: spacing.md },
});

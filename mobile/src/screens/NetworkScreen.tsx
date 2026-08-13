import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { requestAddProxy, requestDisableProxy, subscribeTo } from "../telegram/client";
import { Button, ScreenContainer } from "../components";
import { colors, radii, spacing, typography } from "../theme";

type ProxyKind = "socks5" | "http";

function describeState(type?: string): string {
  switch (type) {
    case "connectionStateWaitingForNetwork":
      return "Waiting for network";
    case "connectionStateConnectingToProxy":
      return "Connecting to proxy…";
    case "connectionStateConnecting":
      return "Connecting…";
    case "connectionStateUpdating":
      return "Updating…";
    case "connectionStateReady":
      return "Connected";
    default:
      return "Unknown";
  }
}

export default function NetworkScreen() {
  const [server, setServer] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [kind, setKind] = useState<ProxyKind>("socks5");
  const [connectionState, setConnectionState] = useState("Unknown");

  useEffect(() => {
    return subscribeTo("updateConnectionState", (data) => {
      setConnectionState(describeState(data?.state?.["@type"]));
    });
  }, []);

  const onConnect = () => {
    const portNum = Number(port.trim());
    if (!server.trim() || !Number.isFinite(portNum)) return;
    requestAddProxy(server.trim(), portNum, kind, username.trim(), password);
  };

  return (
    <ScreenContainer scroll>
      <Text style={styles.title}>Network</Text>
      <Text style={styles.hint}>
        VPN detection, bandwidth throttling, and latency testing are desktop-specific — the OS
        already manages a phone's network path, so there isn't a meaningful mobile equivalent.
        Proxy configuration carries over directly, since it's a real TDLib feature.
      </Text>

      <Text style={styles.sectionTitle}>Connection: {connectionState}</Text>

      <View style={styles.kindRow}>
        <View style={styles.kindButton}>
          <Button title="SOCKS5" variant={kind === "socks5" ? "primary" : "secondary"} onPress={() => setKind("socks5")} />
        </View>
        <View style={styles.kindButton}>
          <Button title="HTTP" variant={kind === "http" ? "primary" : "secondary"} onPress={() => setKind("http")} />
        </View>
      </View>

      <TextInput
        style={styles.input}
        placeholder="Server"
        placeholderTextColor={colors.textTertiary}
        value={server}
        onChangeText={setServer}
      />
      <TextInput
        style={styles.input}
        placeholder="Port"
        placeholderTextColor={colors.textTertiary}
        keyboardType="number-pad"
        value={port}
        onChangeText={setPort}
      />
      <TextInput
        style={styles.input}
        placeholder="Username (optional)"
        placeholderTextColor={colors.textTertiary}
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        placeholder="Password (optional)"
        placeholderTextColor={colors.textTertiary}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />

      <Button title="Connect via proxy" onPress={onConnect} />
      <View style={styles.spacer} />
      <Button title="Disable proxy" variant="destructive" onPress={requestDisableProxy} />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text, marginBottom: spacing.sm },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.lg },
  sectionTitle: { ...typography.uiEmphasis, color: colors.text, marginBottom: spacing.md },
  kindRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  kindButton: { flex: 1 },
  input: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    padding: spacing.md,
    color: colors.text,
    marginBottom: spacing.md,
  },
  spacer: { height: spacing.md },
});

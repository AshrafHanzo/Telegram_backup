import { useCallback, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import * as appLock from "../security/appLock";
import * as googleSignin from "../google/signin";
import { useAuthStore } from "../telegram/authStore";
import AppLockSetupFlow from "./AppLockSetupFlow";
import { AppHeader, Row, ThemedSwitch, TopTabRow } from "../components";
import { colors, spacing, typography } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Settings">;

const Chevron = () => <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />;

function RowIcon({ name }: { name: keyof typeof Ionicons.glyphMap }) {
  return <Ionicons name={name} size={20} color={colors.textSecondary} />;
}

export default function SettingsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const [lockStatus, setLockStatus] = useState<appLock.AppLockStatus>({
    enabled: false,
    email: null,
  });
  const [settingUpLock, setSettingUpLock] = useState(false);
  const [biometricOn, setBiometricOn] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [googleAccount, setGoogleAccount] = useState<googleSignin.GoogleAccount | null>(null);
  const logout = useAuthStore((s) => s.logout);

  const load = useCallback(async () => {
    const [status, biometricEnabled, hardwareAvailable] = await Promise.all([
      appLock.getStatus(),
      appLock.isBiometricEnabled(),
      appLock.isBiometricHardwareAvailable(),
    ]);
    setLockStatus(status);
    setBiometricOn(biometricEnabled);
    setBiometricAvailable(hardwareAvailable);
    setGoogleAccount(googleSignin.getCurrentAccount());
  }, []);

  // GoogleAccountScreen is reached via `navigate` (push), so this screen
  // stays mounted underneath it — refire on every focus (not just mount) so
  // signing in/out and pressing back shows fresh data immediately instead of
  // stale state until a tab switch or app restart.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onToggleAppLock = async (value: boolean) => {
    if (value) {
      setSettingUpLock(true);
      return;
    }
    Alert.alert("Turn off App Lock?", "You won't be asked for a password when opening the app.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Turn off",
        style: "destructive",
        onPress: async () => {
          await appLock.disable();
          await load();
        },
      },
    ]);
  };

  const onLogout = () => {
    Alert.alert(
      "Log out of Telegram?",
      "You'll need your phone number and a new login code from Telegram to sign back in on this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Log out",
          style: "destructive",
          onPress: () => {
            logout().catch((e: any) => {
              Alert.alert("Log out failed", e?.message ?? String(e));
            });
          },
        },
      ],
    );
  };

  const onToggleBiometric = async (value: boolean) => {
    try {
      const applied = await appLock.setBiometricEnabled(value);
      setBiometricOn(applied ? value : biometricOn);
      if (value && !applied) {
        Alert.alert("Fingerprint not confirmed", "Try again to enable fingerprint unlock.");
      }
    } catch (e: any) {
      Alert.alert("Couldn't update fingerprint unlock", e?.message ?? String(e));
    }
  };

  if (settingUpLock) {
    return (
      <AppLockSetupFlow
        mode="setup"
        onComplete={async () => {
          setSettingUpLock(false);
          await load();
        }}
        onCancel={() => setSettingUpLock(false)}
      />
    );
  }

  return (
    <View style={styles.container}>
      <AppHeader title="Settings" />
      <TopTabRow active="settings" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
      >
        <Text style={styles.sectionTitle}>Account</Text>
        <Row
          label="Google Account"
          hint={googleAccount ? googleAccount.email : "Sign in to sync App Lock & credentials"}
          icon={<RowIcon name="logo-google" />}
          right={<Chevron />}
          onPress={() => navigation.navigate("GoogleAccount")}
        />
        <Row
          label="Telegram API Credentials"
          icon={<RowIcon name="key-outline" />}
          right={<Chevron />}
          onPress={() => navigation.navigate("Credentials")}
        />
        <Row
          label="Log out of Telegram"
          icon={<RowIcon name="log-out-outline" />}
          destructive
          onPress={onLogout}
        />

        <Text style={styles.sectionTitle}>Security</Text>
        <Row
          label="App Lock"
          hint={lockStatus.enabled ? lockStatus.email ?? "On" : "Off"}
          icon={<RowIcon name="lock-closed-outline" />}
          right={<ThemedSwitch value={lockStatus.enabled} onValueChange={onToggleAppLock} />}
        />
        {lockStatus.enabled && biometricAvailable && (
          <Row
            label="Unlock with Fingerprint"
            icon={<RowIcon name="finger-print-outline" />}
            right={<ThemedSwitch value={biometricOn} onValueChange={onToggleBiometric} />}
          />
        )}
        {lockStatus.enabled && !biometricAvailable && (
          <Text style={styles.hint}>
            Set up a fingerprint or face unlock in your phone's settings to use it here too.
          </Text>
        )}

        <Text style={styles.sectionTitle}>Storage</Text>
        <Row
          label="Activity Log"
          icon={<RowIcon name="time-outline" />}
          right={<Chevron />}
          onPress={() => navigation.navigate("AuditLog")}
        />
        <Row
          label="Backup & Restore"
          icon={<RowIcon name="cloud-upload-outline" />}
          right={<Chevron />}
          onPress={() => navigation.navigate("Backup")}
        />
        <Row
          label="Temp Links"
          icon={<RowIcon name="link-outline" />}
          right={<Chevron />}
          onPress={() => navigation.navigate("ShareLinks")}
        />
        <Row
          label="Network"
          icon={<RowIcon name="wifi-outline" />}
          right={<Chevron />}
          onPress={() => navigation.navigate("Network")}
        />
        <Row
          label="Encryption Vault"
          icon={<RowIcon name="shield-checkmark-outline" />}
          right={<Chevron />}
          onPress={() => navigation.navigate("Vault")}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textTertiary,
    textTransform: "uppercase",
    marginTop: spacing.xl,
    marginBottom: spacing.xs,
  },
  hint: { ...typography.metadata, color: colors.textSecondary, marginTop: spacing.xs, marginBottom: spacing.sm },
});

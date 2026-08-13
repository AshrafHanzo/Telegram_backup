import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import * as appLock from "../security/appLock";
import * as drive from "../google/drive";
import * as googleSignin from "../google/signin";
import { saveCredentials } from "../telegram/credentials";
import { isRemoteBackupEnabled, setRemoteBackupEnabled } from "../telegram/remoteSync";
import { Button, ScreenContainer, ThemedSwitch } from "../components";
import { colors, spacing, typography } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "GoogleAccount">;

export default function GoogleAccountScreen({ navigation }: Props) {
  const [account, setAccount] = useState<googleSignin.GoogleAccount | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remoteBackupOn, setRemoteBackupOn] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const silent = await googleSignin.signInSilently();
      const resolved = silent ?? googleSignin.getCurrentAccount();
      setAccount(resolved);
      setRemoteBackupOn(await isRemoteBackupEnabled());
      // Reopening this screen while already signed in should show current
      // data, not whatever was last pulled by an explicit "Sync now" tap.
      if (resolved) {
        syncFromDrive().catch(() => {});
      }
    } finally {
      // Always reach the loaded state, even if a step above throws (e.g. a
      // transient AsyncStorage error) — otherwise the screen is stuck on
      // its loading spinner forever, with Sign in/Sync now/Sign out all
      // unreachable and no error shown.
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onToggleRemoteBackup = async (value: boolean) => {
    setRemoteBackupOn(value);
    try {
      await setRemoteBackupEnabled(value);
    } catch (e: any) {
      setRemoteBackupOn(!value);
      Alert.alert("Couldn't update setting", e?.message ?? String(e));
    }
  };

  const syncFromDrive = async () => {
    const payload = await drive.pull();
    if (payload?.api_id && payload?.api_hash) {
      await saveCredentials({ apiId: Number(payload.api_id), apiHash: payload.api_hash });
    }
    await appLock.syncFromDrive();
  };

  const onSignIn = async () => {
    setBusy(true);
    try {
      const acct = await googleSignin.signIn();
      setAccount(acct);
      await syncFromDrive();
      Alert.alert("Signed in", "Pulled your Telegram credentials and App Lock settings.");
    } catch (e: any) {
      Alert.alert("Sign-in failed", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSyncNow = async () => {
    setBusy(true);
    try {
      await syncFromDrive();
      Alert.alert("Synced", "Pulled the latest settings from Drive.");
    } catch (e: any) {
      Alert.alert("Sync failed", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    await googleSignin.signOut();
    setAccount(null);
  };

  if (!loaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScreenContainer>
      <Text style={styles.title}>Google Account</Text>
      {account ? (
        <>
          <Text style={styles.hint}>Signed in as {account.email}</Text>
          {busy ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <>
              <Button title="Sync now" variant="secondary" onPress={onSyncNow} />
              <View style={styles.spacer} />
              <Button title="Sign out" variant="destructive" onPress={onSignOut} />
            </>
          )}

          <View style={styles.divider} />
          <View style={styles.toggleRow}>
            <View style={styles.toggleText}>
              <Text style={styles.toggleLabel}>Remote Backup</Text>
              <Text style={styles.hint}>
                Manage your desktop's backup folders from this phone — browse file names and
                photo previews even while the desktop is off, and add or remove backup sources
                remotely.
              </Text>
            </View>
            <ThemedSwitch value={remoteBackupOn} onValueChange={onToggleRemoteBackup} />
          </View>
          {remoteBackupOn && (
            <Button title="Open Remote Backup" onPress={() => navigation.navigate("RemoteBackup")} />
          )}
        </>
      ) : (
        <>
          <Text style={styles.hint}>
            Sign in to sync your Telegram API credentials and App Lock password across devices,
            the same way the desktop app does.
          </Text>
          <Button title="Continue with Google" onPress={onSignIn} loading={busy} />
        </>
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.canvas },
  title: { ...typography.title, color: colors.text, marginBottom: spacing.sm },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.lg },
  spacer: { height: spacing.md },
  divider: { height: 1, backgroundColor: colors.borderSubtle, marginVertical: spacing.lg },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  toggleText: { flex: 1, marginRight: spacing.md },
  toggleLabel: { ...typography.uiEmphasis, color: colors.text, marginBottom: spacing.xs },
});

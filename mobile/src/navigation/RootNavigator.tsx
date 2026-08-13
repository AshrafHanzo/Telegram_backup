import { useCallback, useEffect, useState } from "react";
import { AppState, AppStateStatus } from "react-native";
import { DarkTheme, NavigationContainer, Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { colors } from "../theme";
import { useAuthStore } from "../telegram/authStore";
import * as appLock from "../security/appLock";
import { LoadingScreen } from "../components";
import AuthFlowScreen from "../screens/AuthFlowScreen";
import AppLockScreen from "../screens/AppLockScreen";
import HomeScreen from "../screens/HomeScreen";
import FolderListScreen from "../screens/FolderListScreen";
import FileListScreen from "../screens/FileListScreen";
import SettingsScreen from "../screens/SettingsScreen";
import GoogleAccountScreen from "../screens/GoogleAccountScreen";
import BackupScreen from "../screens/BackupScreen";
import ShareLinksScreen from "../screens/ShareLinksScreen";
import SearchScreen from "../screens/SearchScreen";
import GroupsScreen from "../screens/GroupsScreen";
import PreviewScreen from "../screens/PreviewScreen";
import ArchiveScreen from "../screens/ArchiveScreen";
import CredentialsScreen from "../screens/CredentialsScreen";
import VideoPlayerScreen from "../screens/VideoPlayerScreen";
import NetworkScreen from "../screens/NetworkScreen";
import VaultScreen from "../screens/VaultScreen";
import RemoteBackupScreen from "../screens/RemoteBackupScreen";
import AuditLogScreen from "../screens/AuditLogScreen";
import { TransferBar } from "../components";
import type { RootStackParamList } from "./types";

const Stack = createNativeStackNavigator<RootStackParamList>();

// Mirrors the desktop app's dark Telegram-blue palette so both apps read as
// the same product.
const navigationTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.canvas,
    card: colors.sidebar,
    text: colors.text,
    border: colors.border,
    notification: colors.accent,
  },
};

const screenOptions = {
  headerStyle: { backgroundColor: colors.sidebar },
  headerTintColor: colors.text,
  headerTitleStyle: { color: colors.text },
  contentStyle: { backgroundColor: colors.canvas },
};

export default function RootNavigator() {
  const kind = useAuthStore((s) => s.kind);
  const isReady = kind === "ready";
  const [lockChecked, setLockChecked] = useState(false);
  const [locked, setLocked] = useState(false);
  const [lockEmail, setLockEmail] = useState<string | null>(null);

  const checkLock = useCallback(async () => {
    const status = await appLock.getStatus();
    setLocked(status.enabled);
    setLockEmail(status.email);
    setLockChecked(true);
  }, []);

  useEffect(() => {
    if (isReady) {
      checkLock();
    } else {
      setLockChecked(false);
      setLocked(false);
    }
  }, [isReady, checkLock]);

  // Re-check whenever the app comes back to the foreground — otherwise a
  // lock enabled on another device (or from this device while backgrounded)
  // would only ever engage after a full restart, since nothing else
  // triggers a recheck while the app is already running.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active" && isReady) {
        checkLock();
      }
    });
    return () => subscription.remove();
  }, [isReady, checkLock]);

  // Also re-check on any explicit lock change (`setPassword`/`disable`, and
  // `syncFromDrive`). This closes a real race with `authStore.init()`: it
  // fires `appLock.syncFromDrive()` in the background WITHOUT awaiting it
  // (`.catch(() => {})`, no `await`) right after `startClient()` resolves —
  // and `startClient()`'s own `updateAuthorizationState` push is what flips
  // `kind` to "ready" in the first place. So the boot-time `checkLock()`
  // above (which fires as soon as `isReady` flips true) can easily run and
  // resolve before that unawaited `syncFromDrive()` has finished writing the
  // synced status to AsyncStorage — the initial read would then miss it
  // until the next foreground/restart. Subscribing here means that once
  // `syncFromDrive()` does resolve and calls `notifyLockChange()`, this
  // re-runs `checkLock()` with the now-current data.
  useEffect(() => {
    return appLock.onLockChange(() => {
      if (isReady) checkLock();
    });
  }, [isReady, checkLock]);

  if (isReady && !lockChecked) {
    return <LoadingScreen showSpinner />;
  }

  if (isReady && locked) {
    return <AppLockScreen email={lockEmail} onUnlock={() => setLocked(false)} />;
  }

  return (
    <NavigationContainer theme={navigationTheme}>
      <Stack.Navigator screenOptions={screenOptions} initialRouteName={isReady ? "Home" : "Auth"}>
        {isReady ? (
          <>
            <Stack.Screen
              name="Home"
              component={HomeScreen}
              options={{ headerShown: false, animation: "none" }}
            />
            <Stack.Screen
              name="Folders"
              component={FolderListScreen}
              options={{ headerShown: false, animation: "none" }}
            />
            <Stack.Screen name="Files" component={FileListScreen} />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{ headerShown: false, animation: "none" }}
            />
            <Stack.Screen
              name="GoogleAccount"
              component={GoogleAccountScreen}
              options={{ title: "Google Account" }}
            />
            <Stack.Screen name="Backup" component={BackupScreen} options={{ title: "Backup" }} />
            <Stack.Screen
              name="ShareLinks"
              component={ShareLinksScreen}
              options={{ headerShown: false, animation: "none" }}
            />
            <Stack.Screen name="Search" component={SearchScreen} options={{ title: "Search" }} />
            <Stack.Screen name="Groups" component={GroupsScreen} options={{ title: "Groups" }} />
            <Stack.Screen
              name="Preview"
              component={PreviewScreen}
              options={{ title: "Preview" }}
            />
            <Stack.Screen
              name="Archive"
              component={ArchiveScreen}
              options={{ title: "Archive" }}
            />
            <Stack.Screen
              name="Credentials"
              component={CredentialsScreen}
              options={{ title: "API Credentials" }}
            />
            <Stack.Screen
              name="VideoPlayer"
              component={VideoPlayerScreen}
              options={{ title: "Video", headerStyle: { backgroundColor: "#000" }, headerTintColor: "#fff" }}
            />
            <Stack.Screen name="Network" component={NetworkScreen} options={{ title: "Network" }} />
            <Stack.Screen
              name="Vault"
              component={VaultScreen}
              options={{ headerShown: false, animation: "none" }}
            />
            <Stack.Screen
              name="RemoteBackup"
              component={RemoteBackupScreen}
              options={{ title: "Remote Backup" }}
            />
            <Stack.Screen
              name="AuditLog"
              component={AuditLogScreen}
              options={{ title: "Activity" }}
            />
          </>
        ) : (
          <Stack.Screen name="Auth" component={AuthFlowScreen} options={{ headerShown: false }} />
        )}
      </Stack.Navigator>
      {isReady && <TransferBar />}
    </NavigationContainer>
  );
}

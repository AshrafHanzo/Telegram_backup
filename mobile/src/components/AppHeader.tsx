import { ReactNode, useCallback, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as googleSignin from "../google/signin";
import type { RootStackParamList } from "../navigation/types";
import { colors, spacing, typography } from "../theme";

interface Props {
  title: string;
  avatarUri?: string | null;
  onAvatarPress?: () => void;
  trailing?: ReactNode;
}

// Mirrors the reference app's top bar: a circular avatar on the left
// (tappable — opens account/settings), a bold screen title, and a trailing
// icon slot (notification bell here, in place of the reference's premium
// badge) — rendered as a plain screen header, not React Navigation's
// default title bar, so this exact layout applies consistently everywhere.
// Adds the device's own status-bar/notch inset on top of its base padding —
// without it the title sits under the status bar on tall-notch phones and
// looks fine only on the specific device it was eyeballed on.
//
// The avatar defaults to the signed-in Google account's own photo (same
// account already synced from the desktop app) and re-checks it every time
// the screen regains focus, so signing in/out from the Google Account screen
// updates every header without each caller having to fetch and pass it down
// individually — `avatarUri`/`onAvatarPress` only exist to override that.
export default function AppHeader({ title, avatarUri, onAvatarPress, trailing }: Props) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [accountPhoto, setAccountPhoto] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      setAccountPhoto(googleSignin.getCurrentAccount()?.photo ?? null);
    }, []),
  );

  const resolvedAvatarUri = avatarUri !== undefined ? avatarUri : accountPhoto;
  const handleAvatarPress = onAvatarPress ?? (() => navigation.navigate("GoogleAccount"));

  return (
    <View style={[styles.row, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable style={styles.avatar} onPress={handleAvatarPress}>
        {resolvedAvatarUri ? (
          <Image source={{ uri: resolvedAvatarUri }} style={styles.avatarImage} />
        ) : (
          <Ionicons name="person" size={18} color={colors.textSecondary} />
        )}
      </Pressable>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImage: { width: 36, height: 36 },
  title: { ...typography.appTitle, color: colors.text, flex: 1 },
});

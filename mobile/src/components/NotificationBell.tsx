import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { countUnread, fetchAuditLog, getLastSeenAt } from "../telegram/auditLog";
import { colors, typography } from "../theme";

interface Props {
  onPress: () => void;
}

export default function NotificationBell({ onPress }: Props) {
  const [unread, setUnread] = useState(0);

  // Rendered inside HomeScreen/FolderListScreen (both screens), so it can
  // call useFocusEffect itself — useFocusEffect works in any descendant of a
  // navigator screen, not just the screen component. Tapping the bell pushes
  // AuditLogScreen (which marks the log seen); refiring on focus (not just
  // mount) means pressing back clears the badge immediately instead of
  // waiting for a tab switch or app restart.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const [entries, lastSeenAt] = await Promise.all([fetchAuditLog(), getLastSeenAt()]);
          if (!cancelled) setUnread(countUnread(entries, lastSeenAt));
        } catch {
          // Best-effort — a failed fetch just means no badge, not a crash.
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  return (
    <Pressable onPress={onPress} style={styles.button}>
      <Ionicons name="notifications" size={18} color={colors.text} />
      {unread > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{unread > 9 ? "9+" : unread}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { padding: 6 },
  badge: {
    position: "absolute",
    top: 2,
    right: 2,
    backgroundColor: colors.danger,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  badgeText: { ...typography.badge, color: "#fff", fontSize: 9 },
});

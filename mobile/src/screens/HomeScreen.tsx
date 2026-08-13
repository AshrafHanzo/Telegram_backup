import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import { AppHeader, EmptyState, NotificationBell, Row, SectionHeader, TopTabRow } from "../components";
import { AuditLogEntry, fetchAuditLog, markAuditLogSeenNow } from "../telegram/auditLog";
import { colors, spacing } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

function eventIcon(eventType: string): keyof typeof Ionicons.glyphMap {
  if (eventType.includes("failed")) return "warning";
  if (eventType.includes("completed") || eventType.includes("uploaded")) return "checkmark-circle";
  if (eventType.includes("remote_job")) return "phone-portrait";
  return "time";
}

function eventLabel(eventType: string): string {
  return eventType
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatWhen(epochSeconds: number): string {
  const deltaMs = Date.now() - epochSeconds * 1000;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

// The reference app's "Home" tab shows a recent-files feed; this app has no
// cross-folder recent-files index to draw from, so Home shows recent
// *activity* instead (the same Telegram-synced audit log the notification
// bell already reads) — real, already-available data rather than a
// placeholder.
export default function HomeScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries(await fetchAuditLog());
    } catch {
      // Best-effort — an empty feed just means no activity shown yet.
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    markAuditLogSeenNow();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  return (
    <View style={styles.container}>
      <AppHeader
        title="Home"
        trailing={<NotificationBell onPress={() => navigation.navigate("AuditLog")} />}
      />
      <TopTabRow active="home" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <SectionHeader
          title="Recent activity"
          actionLabel="See all"
          onAction={() => navigation.navigate("AuditLog")}
        />
        {!loading && entries.length === 0 && (
          <EmptyState
            icon={<Ionicons name="sparkles" size={30} color={colors.accent} />}
            title="No activity yet"
            description="Backups, uploads, and remote jobs will show up here once something happens."
            tone="accent"
          />
        )}
        {entries.slice(0, 8).map((entry) => (
          <Row
            key={entry.id}
            label={eventLabel(entry.event_type)}
            hint={`${entry.detail} · ${formatWhen(entry.created_at)}`}
            icon={<Ionicons name={eventIcon(entry.event_type)} size={20} color={colors.textSecondary} />}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
});

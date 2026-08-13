import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AuditLogEntry, fetchAuditLog, markAuditLogSeenNow } from "../telegram/auditLog";
import { EmptyState, Row, ScreenContainer } from "../components";
import { colors, spacing, typography } from "../theme";

function eventLabel(eventType: string): string {
  return eventType
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function eventIcon(eventType: string): keyof typeof Ionicons.glyphMap {
  if (eventType.includes("failed")) return "warning";
  if (eventType.includes("completed") || eventType.includes("uploaded")) return "checkmark-circle";
  if (eventType.includes("remote_job")) return "phone-portrait";
  return "time";
}

function formatWhen(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

export default function AuditLogScreen() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchAuditLog();
      setEntries(result);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScreenContainer
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
    >
      <Text style={styles.hint}>
        Synced from Telegram — the same activity history desktop keeps, covering the last 30
        days.
      </Text>
      {entries.length === 0 && (
        <EmptyState
          icon={<Ionicons name="time" size={30} color={colors.accent} />}
          title="No activity recorded yet"
          description={error ?? "Backups, uploads, and remote jobs will show up here."}
          tone="accent"
        />
      )}
      {entries.map((entry) => (
        <Row
          key={entry.id}
          label={eventLabel(entry.event_type)}
          hint={`${entry.detail} · ${formatWhen(entry.created_at)}`}
          icon={<Ionicons name={eventIcon(entry.event_type)} size={20} color={colors.textSecondary} />}
        />
      ))}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.canvas },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.lg },
});

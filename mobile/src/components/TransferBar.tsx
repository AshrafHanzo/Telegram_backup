import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTransferStore } from "../telegram/transferStore";
import { colors, radii, spacing, typography } from "../theme";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatSpeed(bps: number): string {
  if (bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}

// Mounted once, globally, above the navigator (see RootNavigator.tsx) so
// active transfers stay visible no matter which screen you're on — mirrors
// desktop's persistent TransferCenter/UploadQueue/DownloadQueue, and its
// aggregate live speed line doubles as this app's bandwidth widget.
export default function TransferBar() {
  const insets = useSafeAreaInsets();
  const transfers = useTransferStore((s) => s.transfers);
  const dismiss = useTransferStore((s) => s.dismiss);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const [expanded, setExpanded] = useState(false);

  if (transfers.length === 0) return null;

  const active = transfers.filter((t) => t.status === "active");
  const totalSpeed = active.reduce((sum, t) => sum + t.speedBps, 0);
  const uploading = active.filter((t) => t.kind === "upload").length;
  const downloading = active.filter((t) => t.kind === "download").length;

  const summaryParts: string[] = [];
  if (uploading > 0) summaryParts.push(`${uploading} uploading`);
  if (downloading > 0) summaryParts.push(`${downloading} downloading`);
  if (summaryParts.length === 0) summaryParts.push(`${transfers.length} finished`);

  return (
    <View
      style={[styles.container, { bottom: insets.bottom + spacing.md }]}
      pointerEvents="box-none"
    >
      <Pressable style={styles.summaryBar} onPress={() => setExpanded((e) => !e)}>
        <Text style={styles.summaryText} numberOfLines={1}>
          {summaryParts.join(" · ")}
        </Text>
        {totalSpeed > 0 && <Text style={styles.speedText}>{formatSpeed(totalSpeed)}</Text>}
        <Text style={styles.chevron}>{expanded ? "︿" : "﹀"}</Text>
      </Pressable>
      {expanded && (
        <View style={styles.list}>
          {transfers.map((t) => (
            <View key={t.id} style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {t.kind === "upload" ? "↑" : "↓"} {t.name}
                </Text>
                <Text style={styles.rowMeta}>
                  {t.status === "failed"
                    ? t.error ?? "Failed"
                    : t.status === "completed"
                      ? "Done"
                      : t.totalBytes > 0
                        ? `${formatBytes(t.transferredBytes)} / ${formatBytes(t.totalBytes)}${
                            t.speedBps > 0 ? ` · ${formatSpeed(t.speedBps)}` : ""
                          }`
                        : formatBytes(t.transferredBytes)}
                </Text>
              </View>
              {t.status === "active" && t.totalBytes > 0 && (
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      { width: `${Math.min(100, (t.transferredBytes / t.totalBytes) * 100)}%` },
                    ]}
                  />
                </View>
              )}
              {t.status !== "active" && (
                <Pressable onPress={() => dismiss(t.id)} style={styles.dismissButton}>
                  <Text style={styles.dismissText}>✕</Text>
                </Pressable>
              )}
            </View>
          ))}
          {transfers.some((t) => t.status !== "active") && (
            <Pressable onPress={clearFinished} style={styles.clearButton}>
              <Text style={styles.clearText}>Clear finished</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.container,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  summaryBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  summaryText: { ...typography.metadata, color: colors.text, flex: 1 },
  speedText: { ...typography.metadata, color: colors.accent },
  chevron: { color: colors.textTertiary, fontSize: 12 },
  list: { borderTopWidth: 1, borderTopColor: colors.borderSubtle, padding: spacing.sm },
  row: { paddingVertical: spacing.xs },
  rowText: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  rowName: { ...typography.metadata, color: colors.text, flexShrink: 1 },
  rowMeta: { ...typography.metadata, color: colors.textTertiary },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.borderSubtle,
    marginTop: spacing.xs,
    overflow: "hidden",
  },
  progressFill: { height: 3, backgroundColor: colors.accent },
  dismissButton: { position: "absolute", right: 0, top: 0, padding: spacing.xs },
  dismissText: { color: colors.textTertiary, fontSize: 12 },
  clearButton: { alignItems: "center", paddingVertical: spacing.xs },
  clearText: { ...typography.metadata, color: colors.accent },
});

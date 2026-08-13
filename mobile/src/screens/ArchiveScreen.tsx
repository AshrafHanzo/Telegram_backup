import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type JSZip from "jszip";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import { downloadFileTracked, shareFile } from "../telegram/download";
import { ArchiveEntry, extractArchiveEntry, listArchiveContents, openArchive } from "../telegram/archive";
import { colors, spacing, typography } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Archive">;

export default function ArchiveScreen({ route }: Props) {
  const { fileId, name } = route.params;
  const [zip, setZip] = useState<JSZip | null>(null);
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [extractingPath, setExtractingPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const localFile = await downloadFileTracked(fileId, name);
        const opened = await openArchive(localFile);
        if (cancelled) return;
        setZip(opened);
        setEntries(listArchiveContents(opened));
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, name]);

  const onExtract = async (entry: ArchiveEntry) => {
    if (!zip || entry.isDirectory) return;
    setExtractingPath(entry.path);
    try {
      const extracted = await extractArchiveEntry(zip, entry.path);
      await shareFile(extracted);
    } catch (e: any) {
      Alert.alert("Extract failed", e?.message ?? String(e));
    } finally {
      setExtractingPath(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.list}
      data={entries}
      keyExtractor={(item) => item.path}
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
          onPress={() => onExtract(item)}
          disabled={item.isDirectory || extractingPath === item.path}
        >
          <Text style={styles.rowText} numberOfLines={1}>
            {item.isDirectory ? "📁 " : "📄 "}
            {item.path}
          </Text>
          {extractingPath === item.path && <ActivityIndicator color={colors.accent} />}
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { backgroundColor: colors.canvas },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.xl, backgroundColor: colors.canvas },
  error: { color: colors.danger, textAlign: "center" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  rowText: { ...typography.ui, color: colors.text, flexShrink: 1 },
});

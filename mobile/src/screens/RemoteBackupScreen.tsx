import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Pressable } from "react-native";
import {
  CatalogEntry,
  fetchCatalog,
  fetchJobStatus,
  requestAddSource,
  requestCopyEntry,
  requestMoveEntry,
  requestRemoveSource,
  RemoteJob,
  SourceCatalog,
} from "../telegram/remoteSync";
import { Button } from "../components";
import { colors, radii, spacing, typography } from "../theme";

function jobLabel(job: RemoteJob): string {
  switch (job.action.type) {
    case "add_source":
      return `Add "${job.action.display_name ?? job.action.path}"`;
    case "remove_source":
      return `Remove source ${job.action.source_id}`;
    case "copy_entry":
      return `Copy "${baseName(job.action.relative_path)}"`;
    case "move_entry":
      return `Move "${baseName(job.action.relative_path)}"`;
    // Share-link requests ride the same queue, so they show up here too —
    // useful for seeing that one is still waiting on the desktop app.
    case "create_folder_share":
      return `Create share link for "${job.action.folder_name}"`;
    case "revoke_folder_share":
      return `Revoke share link ${job.action.share_id}`;
  }
}

function formatSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(epochSeconds?: number | null): string {
  if (epochSeconds === undefined || epochSeconds === null) return "Unknown";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function baseName(relativePath: string): string {
  return relativePath.split("/").pop() ?? relativePath;
}

interface Clipboard {
  sourceId: string;
  sourceName: string;
  relativePath: string;
  mode: "copy" | "cut";
}

// Every directory in a synced catalog carries its own entry (see
// remote_catalog.rs's build_catalog_for_source, which pushes a CatalogEntry
// for every walked path, not just leaf files) — so the immediate children of
// `path` are simply the entries exactly one path segment deeper.
function childrenAt(entries: CatalogEntry[], path: string): CatalogEntry[] {
  const depth = path ? path.split("/").length : 0;
  const prefix = path ? `${path}/` : "";
  return entries
    .filter((entry) => (path ? entry.relative_path.startsWith(prefix) : true))
    .filter((entry) => entry.relative_path.split("/").length === depth + 1)
    .sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return baseName(a.relative_path).localeCompare(baseName(b.relative_path));
    });
}

export default function RemoteBackupScreen() {
  const [catalogs, setCatalogs] = useState<SourceCatalog[]>([]);
  const [jobs, setJobs] = useState<RemoteJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [browsingSourceId, setBrowsingSourceId] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newName, setNewName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [pasting, setPasting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [catalogResult, jobsResult] = await Promise.all([fetchCatalog(), fetchJobStatus()]);
      setCatalogs(catalogResult);
      setJobs(jobsResult.slice().reverse());
    } catch (e: any) {
      Alert.alert("Failed to load", e?.message ?? String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const browsingSource = useMemo(
    () => catalogs.find((s) => s.source_id === browsingSourceId) ?? null,
    [catalogs, browsingSourceId],
  );
  const visibleEntries = useMemo(
    () => (browsingSource ? childrenAt(browsingSource.entries, browsePath) : []),
    [browsingSource, browsePath],
  );

  const openSource = (source: SourceCatalog) => {
    setBrowsingSourceId(source.source_id);
    setBrowsePath("");
  };

  const closeBrowser = () => {
    setBrowsingSourceId(null);
    setBrowsePath("");
  };

  const goUp = () => {
    const parts = browsePath.split("/");
    parts.pop();
    setBrowsePath(parts.join("/"));
  };

  const showProperties = (entry: CatalogEntry, sourceName: string) => {
    const lines = [
      `Name: ${baseName(entry.relative_path)}`,
      `Type: ${entry.is_dir ? "Folder" : "File"}`,
      `Location: ${sourceName}/${entry.relative_path}`,
    ];
    if (!entry.is_dir) lines.push(`Size: ${formatSize(entry.size) || "Unknown"}`);
    lines.push(`Modified: ${formatDate(entry.modified_at)}`);
    Alert.alert("Properties", lines.join("\n"));
  };

  const onLongPressEntry = (entry: CatalogEntry) => {
    if (!browsingSource) return;
    Alert.alert(baseName(entry.relative_path), undefined, [
      { text: "Properties", onPress: () => showProperties(entry, browsingSource.display_name) },
      {
        text: "Copy",
        onPress: () =>
          setClipboard({
            sourceId: browsingSource.source_id,
            sourceName: browsingSource.display_name,
            relativePath: entry.relative_path,
            mode: "copy",
          }),
      },
      {
        text: "Cut",
        onPress: () =>
          setClipboard({
            sourceId: browsingSource.source_id,
            sourceName: browsingSource.display_name,
            relativePath: entry.relative_path,
            mode: "cut",
          }),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const onPaste = async () => {
    if (!clipboard || !browsingSource) return;
    setPasting(true);
    try {
      if (clipboard.mode === "copy") {
        await requestCopyEntry(
          clipboard.sourceId,
          clipboard.relativePath,
          browsingSource.source_id,
          browsePath,
        );
      } else {
        await requestMoveEntry(
          clipboard.sourceId,
          clipboard.relativePath,
          browsingSource.source_id,
          browsePath,
        );
      }
      setClipboard(null);
      Alert.alert(
        "Job submitted",
        "This will take effect the next time your desktop app is open and connected.",
      );
      await load();
    } catch (e: any) {
      Alert.alert("Failed to submit job", e?.message ?? String(e));
    } finally {
      setPasting(false);
    }
  };

  const onAddSource = async () => {
    const path = newPath.trim();
    if (!path) return;
    setSubmitting(true);
    try {
      await requestAddSource(path, newName.trim() || undefined);
      setNewPath("");
      setNewName("");
      Alert.alert(
        "Job submitted",
        "This will take effect the next time your desktop app is open and connected.",
      );
      await load();
    } catch (e: any) {
      Alert.alert("Failed to submit job", e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const onRemoveSource = (source: SourceCatalog) => {
    Alert.alert("Remove backup source?", source.display_name, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try {
            await requestRemoveSource(source.source_id);
            if (browsingSourceId === source.source_id) closeBrowser();
            Alert.alert(
              "Job submitted",
              "This will take effect the next time your desktop app is open and connected.",
            );
            await load();
          } catch (e: any) {
            Alert.alert("Failed to submit job", e?.message ?? String(e));
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (browsingSource) {
    const crumbs = [browsingSource.display_name, ...(browsePath ? browsePath.split("/") : [])];
    return (
      <View style={styles.container}>
        <View style={styles.browserHeader}>
          <Pressable onPress={browsePath ? goUp : closeBrowser}>
            <Text style={styles.backText}>{"‹ Back"}</Text>
          </Pressable>
          <Text style={styles.breadcrumb} numberOfLines={1}>
            {crumbs.join(" / ")}
          </Text>
        </View>
        {clipboard && (
          <View style={styles.pasteBar}>
            <Text style={styles.pasteBarText} numberOfLines={1}>
              {clipboard.mode === "copy" ? "Copy" : "Move"} "{baseName(clipboard.relativePath)}" from{" "}
              {clipboard.sourceName}
            </Text>
            {pasting ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <View style={styles.pasteBarActions}>
                <Pressable onPress={() => setClipboard(null)}>
                  <Text style={styles.pasteCancelText}>Cancel</Text>
                </Pressable>
                <Pressable onPress={onPaste}>
                  <Text style={styles.pasteHereText}>Paste here</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
        <ScrollView contentContainerStyle={styles.browserContent}>
          {visibleEntries.length === 0 && <Text style={styles.hint}>This folder is empty.</Text>}
          {visibleEntries.map((entry) => (
            <Pressable
              key={entry.relative_path}
              style={styles.entryRow}
              onPress={() => entry.is_dir && setBrowsePath(entry.relative_path)}
              onLongPress={() => onLongPressEntry(entry)}
            >
              {entry.cover_base64 ? (
                <Image
                  source={{ uri: `data:image/jpeg;base64,${entry.cover_base64}` }}
                  style={styles.cover}
                />
              ) : (
                <View style={styles.coverPlaceholder}>
                  <Text style={styles.coverPlaceholderText}>{entry.is_dir ? "📁" : "📄"}</Text>
                </View>
              )}
              <View style={styles.entryText}>
                <Text style={styles.entryName} numberOfLines={1}>
                  {baseName(entry.relative_path)}
                </Text>
                {!entry.is_dir && <Text style={styles.entrySize}>{formatSize(entry.size)}</Text>}
              </View>
              {entry.is_dir && <Text style={styles.chevron}>{"›"}</Text>}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.title}>Remote Backup</Text>
      <Text style={styles.hint}>
        Browse your desktop's backup folders and their file metadata — names, sizes, and photo
        previews only, never the files themselves — even while your desktop is offline.
        Press and hold a file or folder for Properties, Copy, or Cut. Every change here takes
        effect next time the desktop app is open and connected.
      </Text>

      <Text style={styles.sectionTitle}>Backup sources</Text>
      {catalogs.length === 0 && (
        <Text style={styles.hint}>
          No sources synced yet — set one up on the desktop app, or add one below.
        </Text>
      )}
      {catalogs.map((source) => (
        <Pressable key={source.source_id} style={styles.sourceCard} onPress={() => openSource(source)}>
          <View style={styles.sourceHeaderText}>
            <Text style={styles.sourceName}>{source.display_name}</Text>
            <Text style={styles.sourceMeta}>
              {source.entries.length} item{source.entries.length === 1 ? "" : "s"}
              {source.truncated ? " (truncated)" : ""}
            </Text>
          </View>
          <Pressable onPress={() => onRemoveSource(source)}>
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        </Pressable>
      ))}

      <Text style={styles.sectionTitle}>Add a backup source</Text>
      <Text style={styles.hint}>
        Type the absolute path as it exists on your desktop (e.g. C:\Users\you\Photos).
      </Text>
      <TextInput
        style={styles.input}
        placeholder="Absolute path on desktop"
        placeholderTextColor={colors.textTertiary}
        autoCapitalize="none"
        value={newPath}
        onChangeText={setNewPath}
      />
      <TextInput
        style={styles.input}
        placeholder="Display name (optional)"
        placeholderTextColor={colors.textTertiary}
        value={newName}
        onChangeText={setNewName}
      />
      <Button title="Submit" onPress={onAddSource} loading={submitting} />

      <Text style={styles.sectionTitle}>Job status</Text>
      {jobs.length === 0 && <Text style={styles.hint}>No jobs submitted yet.</Text>}
      {jobs.map((job) => (
        <View key={job.id} style={styles.jobRow}>
          <Text style={styles.jobLabel} numberOfLines={1}>
            {jobLabel(job)}
          </Text>
          <Text
            style={[
              styles.jobStatus,
              job.status === "completed" && styles.jobStatusCompleted,
              job.status === "failed" && styles.jobStatusFailed,
            ]}
          >
            {job.status}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: spacing.lg },
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.canvas },
  title: { ...typography.title, color: colors.text, marginBottom: spacing.sm },
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.md },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textTertiary,
    textTransform: "uppercase",
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  sourceCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    borderRadius: radii.container,
    marginBottom: spacing.sm,
    padding: spacing.md,
  },
  sourceHeaderText: { flexShrink: 1 },
  sourceName: { ...typography.uiEmphasis, color: colors.text },
  sourceMeta: { ...typography.metadata, color: colors.textTertiary },
  removeText: { color: colors.danger, fontSize: 13 },
  browserHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    gap: spacing.md,
  },
  backText: { color: colors.accent, fontSize: 15 },
  breadcrumb: { flexShrink: 1, ...typography.metadata, color: colors.textSecondary },
  pasteBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: spacing.md,
    backgroundColor: colors.accentSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  pasteBarText: { flex: 1, ...typography.metadata, color: colors.text },
  pasteBarActions: { flexDirection: "row", gap: spacing.lg },
  pasteCancelText: { color: colors.textSecondary, fontSize: 13 },
  pasteHereText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  browserContent: { padding: spacing.lg },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  cover: { width: 36, height: 36, borderRadius: radii.control / 2 },
  coverPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: radii.control / 2,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  coverPlaceholderText: { fontSize: 16 },
  entryText: { flex: 1 },
  entryName: { ...typography.ui, color: colors.text },
  entrySize: { ...typography.metadata, color: colors.textTertiary },
  chevron: { fontSize: 18, color: colors.textTertiary },
  input: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    padding: spacing.md,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  jobRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  jobLabel: { ...typography.metadata, color: colors.text, flexShrink: 1, marginRight: spacing.sm },
  jobStatus: { ...typography.metadata, color: colors.textTertiary, textTransform: "uppercase" },
  jobStatusCompleted: { color: colors.success },
  jobStatusFailed: { color: colors.danger },
});

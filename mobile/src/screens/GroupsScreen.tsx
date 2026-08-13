import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as groups from "../telegram/groups";
import { listFolders, TelegramFolder } from "../telegram/folders";
import { Button, ThemedSwitch } from "../components";
import { colors, radii, spacing, typography } from "../theme";

export default function GroupsScreen() {
  const [groupList, setGroupList] = useState<groups.FolderGroup[]>([]);
  const [folders, setFolders] = useState<TelegramFolder[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [newGroupName, setNewGroupName] = useState("");
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [groupData, folderData, assignmentData] = await Promise.all([
        groups.listGroups(),
        listFolders(),
        groups.getFolderGroupAssignments(),
      ]);
      setGroupList(groupData);
      setFolders(folderData);
      setAssignments(assignmentData);
    } catch (e: any) {
      Alert.alert("Failed to load groups", e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onCreate = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await groups.createGroup(name);
      setNewGroupName("");
      await load();
    } catch (e: any) {
      Alert.alert("Failed to create group", e?.message ?? String(e));
    }
  };

  const onDelete = (group: groups.FolderGroup) => {
    Alert.alert("Delete group?", group.name, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await groups.deleteGroup(group.id);
            await load();
          } catch (e: any) {
            Alert.alert("Failed to delete group", e?.message ?? String(e));
          }
        },
      },
    ]);
  };

  const onToggleFolder = async (groupId: string, chatId: number, assigned: boolean) => {
    try {
      await groups.assignFolderToGroup(chatId, assigned ? groupId : null);
      // Only this one assignment changed — update local state directly
      // instead of refetching all of listGroups/listFolders/
      // getFolderGroupAssignments just to reflect a single toggle.
      setAssignments((prev) => {
        const next = { ...prev };
        if (assigned) {
          next[String(chatId)] = groupId;
        } else {
          delete next[String(chatId)];
        }
        return next;
      });
    } catch (e: any) {
      Alert.alert("Failed to update group", e?.message ?? String(e));
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Folder Groups</Text>
      <Text style={styles.hint}>
        Local organization only — groups don't exist on Telegram's side, so they aren't synced
        anywhere.
      </Text>

      <View style={styles.newGroupRow}>
        <TextInput
          style={styles.input}
          placeholder="New group name"
          placeholderTextColor={colors.textTertiary}
          value={newGroupName}
          onChangeText={setNewGroupName}
        />
        <Button title="Create" onPress={onCreate} />
      </View>

      {groupList.map((group) => (
        <View key={group.id} style={styles.groupCard}>
          <Pressable
            style={styles.groupHeader}
            onPress={() => setExpandedGroupId(expandedGroupId === group.id ? null : group.id)}
          >
            <Text style={styles.groupName}>{group.name}</Text>
            <Pressable onPress={() => onDelete(group)}>
              <Text style={styles.deleteText}>Delete</Text>
            </Pressable>
          </Pressable>
          {expandedGroupId === group.id && (
            <View style={styles.folderList}>
              {folders.map((folder) => (
                <View key={folder.chatId} style={styles.folderRow}>
                  <Text style={styles.folderRowText}>{folder.title}</Text>
                  <ThemedSwitch
                    value={assignments[String(folder.chatId)] === group.id}
                    onValueChange={(value) => onToggleFolder(group.id, folder.chatId, value)}
                  />
                </View>
              ))}
              {folders.length === 0 && <Text style={styles.hint}>No folders yet.</Text>}
            </View>
          )}
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
  hint: { ...typography.metadata, color: colors.textSecondary, marginBottom: spacing.lg },
  newGroupRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.lg },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    padding: spacing.md,
    color: colors.text,
  },
  groupCard: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    borderRadius: radii.container,
    marginBottom: spacing.sm,
  },
  groupHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: spacing.md,
  },
  groupName: { ...typography.uiEmphasis, color: colors.text },
  deleteText: { color: colors.danger },
  folderList: { borderTopWidth: 1, borderTopColor: colors.borderSubtle, padding: spacing.md },
  folderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.xs,
  },
  folderRowText: { ...typography.ui, color: colors.text, flexShrink: 1 },
});

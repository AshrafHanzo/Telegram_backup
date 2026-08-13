import { useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import { searchFiles, SearchResult } from "../telegram/search";
import { Button, EmptyState } from "../components";
import { colors, radii, spacing, typography } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Search">;

export default function SearchScreen({ navigation }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const onSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearched(false);
    try {
      const found = await searchFiles(query);
      setResults(found);
      setSearched(true);
    } catch (e: any) {
      Alert.alert("Search failed", e?.message ?? String(e));
    } finally {
      setSearching(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          placeholder="Search file names"
          placeholderTextColor={colors.textTertiary}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={onSearch}
          autoFocus
        />
        <Button title="Search" onPress={onSearch} disabled={searching} />
      </View>
      <Text style={styles.hint}>
        Searches across each folder's message history already visible to this app — not a live
        Telegram-wide search.
      </Text>

      {searching && <ActivityIndicator color={colors.accent} style={styles.spacer} />}

      <FlatList
        data={results}
        keyExtractor={(item) => `${item.chatId}-${item.messageId}`}
        ListEmptyComponent={
          searched ? (
            <EmptyState
              icon={<Ionicons name="search" size={30} color={colors.warning} />}
              title="No matching files found"
              description="Try a different name, or check the folder on the My files tab directly."
              tone="warning"
            />
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => navigation.navigate("Files", { chatId: item.chatId, title: item.folderTitle })}
          >
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.rowMeta}>{item.folderTitle}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.lg, backgroundColor: colors.canvas },
  searchRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    padding: spacing.md,
    color: colors.text,
  },
  hint: { ...typography.metadata, color: colors.textTertiary, marginBottom: spacing.md },
  spacer: { marginVertical: spacing.md },
  row: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  rowTitle: { ...typography.uiEmphasis, color: colors.text },
  rowMeta: { ...typography.metadata, color: colors.textTertiary },
});

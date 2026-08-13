import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radii, spacing } from "../theme";

interface Props {
  placeholder: string;
  onPressSearch: () => void;
  onPressAdd: () => void;
  addLabel?: string;
}

// Mirrors the reference app's floating search-and-add bar, pinned near the
// bottom of the screen rather than in the header — a pill search field
// (navigates to a dedicated search screen on tap, rather than becoming
// editable in place) paired with a circular accent "+" action button.
// Bottom padding adds the device's gesture-bar/home-indicator inset so the
// bar clears it instead of sitting flush against (or under) it.
export default function SearchFabBar({ placeholder, onPressSearch, onPressAdd, addLabel }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.row, { paddingBottom: insets.bottom + spacing.lg }]}>
      <Pressable style={styles.search} onPress={onPressSearch}>
        <Ionicons name="search" size={18} color={colors.textTertiary} />
        <Text style={styles.placeholder}>{placeholder}</Text>
      </Pressable>
      <Pressable style={styles.fab} onPress={onPressAdd} accessibilityLabel={addLabel ?? "Add"}>
        <Ionicons name="add" size={26} color={colors.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  search: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  placeholder: { color: colors.textTertiary, fontSize: 15 },
  fab: {
    width: 52,
    height: 52,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
});

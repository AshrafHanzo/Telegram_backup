import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import { colors, spacing, typography } from "../theme";

type TabKey = "home" | "myfiles" | "shared" | "vault" | "settings";

const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap; screen: keyof RootStackParamList }[] = [
  { key: "home", label: "Home", icon: "home", screen: "Home" },
  { key: "myfiles", label: "My files", icon: "folder", screen: "Folders" },
  { key: "shared", label: "Shared", icon: "people", screen: "ShareLinks" },
  { key: "vault", label: "Vault", icon: "shield-checkmark", screen: "Vault" },
  { key: "settings", label: "Settings", icon: "settings", screen: "Settings" },
];

interface Props {
  active: TabKey;
}

// Mirrors the reference app's top tab row (Home / My files / Shared /
// Vault / Offline) — a plain visual switcher between top-level sections,
// not a real nested navigator: each tap `replace()`s the current screen so
// switching tabs never piles up back-stack history the way `navigate`
// would. "Settings" stands in for the reference's "Offline" slot, since
// this app has no true offline-file-availability feature to put there.
export default function TopTabRow({ active }: Props) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <View style={styles.row}>
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            style={styles.tab}
            onPress={() => {
              // All five tab targets take no params — cast is safe here;
              // TS can't otherwise unify a generic `keyof RootStackParamList`
              // against `replace`'s per-route overloads.
              if (!isActive) (navigation.replace as (name: string) => void)(tab.screen);
            }}
          >
            <Ionicons
              name={isActive ? tab.icon : (`${tab.icon}-outline` as keyof typeof Ionicons.glyphMap)}
              size={22}
              color={isActive ? colors.accent : colors.textSecondary}
            />
            <Text style={[styles.label, isActive && styles.labelActive]} numberOfLines={1}>
              {tab.label}
            </Text>
            <View style={[styles.underline, isActive && styles.underlineActive]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: spacing.sm, gap: 4 },
  label: { ...typography.metadata, color: colors.textSecondary },
  labelActive: { color: colors.text, fontWeight: "600" },
  underline: { height: 2, width: "70%", marginTop: 4, borderRadius: 1, backgroundColor: "transparent" },
  underlineActive: { backgroundColor: colors.accent },
});

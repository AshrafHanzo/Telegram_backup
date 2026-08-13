import { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, ViewStyle } from "react-native";
import { colors, spacing, typography } from "../theme";

interface Props {
  label: string;
  hint?: string;
  icon?: ReactNode;
  right?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  dimmed?: boolean;
  style?: ViewStyle;
}

// Matches the reference app's list-row style: icon + two-line text block +
// trailing accessory, spacing-only separation (no border lines between
// rows) — used for files, folders, and settings items alike.
export default function Row({
  label,
  hint,
  icon,
  right,
  onPress,
  onLongPress,
  destructive = false,
  disabled = false,
  dimmed = false,
  style,
}: Props) {
  const content = (
    <View style={[styles.row, style]}>
      {icon && <View style={styles.icon}>{icon}</View>}
      <View style={styles.text}>
        <Text
          style={[styles.label, destructive && styles.destructive, dimmed && styles.dimmed]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {hint && (
          <Text style={[styles.hint, dimmed && styles.dimmed]} numberOfLines={2}>
            {hint}
          </Text>
        )}
      </View>
      {right}
    </View>
  );

  if (!onPress && !onLongPress) return content;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      style={({ pressed }) => [styles.pressable, pressed && !disabled && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: { borderRadius: 10 },
  pressed: { backgroundColor: colors.hover },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  text: { flex: 1, marginRight: spacing.sm },
  label: { ...typography.ui, color: colors.text },
  destructive: { color: colors.danger },
  dimmed: { color: colors.textTertiary },
  hint: { ...typography.metadata, color: colors.textSecondary, marginTop: 2 },
});

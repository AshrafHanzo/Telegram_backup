import { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Button from "./Button";
import { colors, spacing, typography } from "../theme";

type Tone = "accent" | "warning" | "success" | "info" | "danger";

interface Props {
  icon: ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: Tone;
}

const TONE_COLORS: Record<Tone, string> = {
  accent: colors.accent,
  warning: colors.warning,
  success: colors.success,
  info: colors.info,
  danger: colors.danger,
};

// Mirrors the reference app's empty states: a glowing colored illustration
// (concentric soft-tinted rings standing in for its custom artwork — no
// gradient/image assets, so this stays pure-style and hot-reloadable), a
// bold centered title, gray description, and a content-width action button.
// `tone` gives each screen's empty state its own color instead of one flat
// gray icon everywhere, which is what made every "nothing here" look
// identical and unpolished before.
export default function EmptyState({ icon, title, description, actionLabel, onAction, tone = "accent" }: Props) {
  const tint = TONE_COLORS[tone];
  return (
    <View style={styles.container}>
      <View style={[styles.glowOuter, { backgroundColor: withAlpha(tint, 0.08) }]}>
        <View style={[styles.glowInner, { backgroundColor: withAlpha(tint, 0.16) }]}>
          <View style={[styles.iconWrap, { backgroundColor: withAlpha(tint, 0.22) }]}>{icon}</View>
        </View>
      </View>
      <Text style={styles.title}>{title}</Text>
      {description && <Text style={styles.description}>{description}</Text>}
      {actionLabel && onAction && (
        <Button title={actionLabel} onPress={onAction} fullWidth={false} />
      )}
    </View>
  );
}

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const styles = StyleSheet.create({
  container: { alignItems: "center", paddingHorizontal: spacing.xl, paddingTop: spacing.xxl * 1.5 },
  glowOuter: {
    width: 132,
    height: 132,
    borderRadius: 66,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xl,
  },
  glowInner: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { ...typography.title, color: colors.text, textAlign: "center", marginBottom: spacing.sm },
  description: {
    ...typography.ui,
    color: colors.textSecondary,
    textAlign: "center",
    marginBottom: spacing.xl,
  },
});

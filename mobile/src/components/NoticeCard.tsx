import { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Button from "./Button";
import { colors, radii, spacing, typography } from "../theme";

interface Props {
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}

export default function NoticeCard({ icon, title, description, actionLabel, onAction, onDismiss }: Props) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        {icon}
        <Text style={styles.title}>{title}</Text>
        {onDismiss && (
          <Pressable onPress={onDismiss} style={styles.dismiss}>
            <Ionicons name="close" size={18} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>
      <Text style={styles.description}>{description}</Text>
      {actionLabel && onAction && (
        <View style={styles.actionWrap}>
          <Button title={actionLabel} variant="secondary" fullWidth={false} onPress={onAction} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.container,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  title: { ...typography.uiEmphasis, color: colors.text, flex: 1 },
  dismiss: { padding: 2 },
  description: { ...typography.ui, color: colors.textSecondary, marginTop: spacing.sm },
  actionWrap: { marginTop: spacing.md, alignItems: "flex-start" },
});

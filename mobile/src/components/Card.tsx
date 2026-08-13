import { ReactNode } from "react";
import { StyleSheet, View, ViewStyle } from "react-native";
import { colors, radii, spacing } from "../theme";

interface Props {
  children: ReactNode;
  style?: ViewStyle;
  raised?: boolean;
}

export default function Card({ children, style, raised = false }: Props) {
  return <View style={[styles.card, raised && styles.raised, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.container,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
  },
  raised: { backgroundColor: colors.surfaceRaised },
});

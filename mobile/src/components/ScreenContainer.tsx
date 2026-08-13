import { ReactNode } from "react";
import { RefreshControlProps, ScrollView, StyleSheet, View, ViewStyle } from "react-native";
import { colors, spacing } from "../theme";

interface Props {
  children: ReactNode;
  scroll?: boolean;
  centered?: boolean;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  style?: ViewStyle;
}

export default function ScreenContainer({ children, scroll = false, centered = false, refreshControl, style }: Props) {
  if (scroll) {
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, centered && styles.centered, style]}
        refreshControl={refreshControl}
      >
        {children}
      </ScrollView>
    );
  }
  return (
    <View style={[styles.container, styles.content, centered && styles.centered, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas },
  content: { flexGrow: 1, padding: spacing.lg },
  centered: { justifyContent: "center" },
});

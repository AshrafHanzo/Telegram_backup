import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import type { File } from "expo-file-system";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import { downloadFileTracked, shareFile } from "../telegram/download";
import { Button } from "../components";
import { colors, spacing } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Preview">;

export default function PreviewScreen({ route }: Props) {
  const { fileId, name } = route.params;
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    downloadFileTracked(fileId, name)
      .then((result) => {
        if (!cancelled) setFile(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, name]);

  const onShare = async () => {
    if (!file) return;
    try {
      await shareFile(file);
    } catch (e: any) {
      Alert.alert("Share failed", e?.message ?? String(e));
    }
  };

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!file) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Image source={{ uri: file.uri }} style={styles.image} contentFit="contain" />
      <View style={styles.actions}>
        <Button title="Share / Save" onPress={onShare} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.xl, backgroundColor: "#000" },
  image: { flex: 1 },
  actions: { padding: spacing.lg },
  error: { color: colors.danger, textAlign: "center" },
});

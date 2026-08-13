import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/types";
import { downloadFile, DownloadProgress } from "../telegram/download";
import { colors, spacing } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "VideoPlayer">;

// Downloads the whole file first, then plays it locally — desktop instead
// transcodes and streams via HLS/fmp4 on demand, which needs a local HTTP
// server and a transcoding pipeline neither of which exist on mobile here.
// For files already in a directly-playable format this has the same result,
// just with an upfront wait instead of instant streaming.
export default function VideoPlayerScreen({ route }: Props) {
  const { fileId, name } = route.params;
  const [uri, setUri] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    downloadFile(fileId, name, (p) => {
      if (!cancelled) setProgress(p);
    })
      .then((file) => {
        if (!cancelled) setUri(file.uri);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, name]);

  const player = useVideoPlayer(uri ?? "", (p) => {
    if (uri) p.play();
  });

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!uri) {
    const percent =
      progress && progress.totalSize > 0
        ? Math.round((progress.downloadedSize / progress.totalSize) * 100)
        : null;
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.hint}>
          {percent !== null ? `Downloading… ${percent}%` : "Downloading…"}
        </Text>
      </View>
    );
  }

  return <VideoView style={styles.video} player={player} nativeControls />;
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#000" },
  video: { flex: 1, backgroundColor: "#000" },
  hint: { color: colors.text, marginTop: spacing.md },
  error: { color: colors.danger, textAlign: "center", padding: spacing.xl },
});

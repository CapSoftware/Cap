import { router, useSegments } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/auth/AuthContext";
import { colors, fonts, radius } from "@/theme";
import { useRecordingUploads } from "@/uploads/recording-upload-provider";
import { recordingUploadProgress } from "@/uploads/recording-upload-queue";

export function RecordingUploadStatus() {
	const insets = useSafeAreaInsets();
	const auth = useAuth();
	const segments = useSegments();
	const { queue, retryRecording } = useRecordingUploads();
	const job = [...queue.jobs].reverse()[0];
	if (!job || auth.status !== "signedIn" || job.status === "recording") {
		return null;
	}

	const percent = Math.round(recordingUploadProgress(job) * 100);
	const canRetry = job.status === "failed" && job.durationSeconds !== null;
	const isRecorder = segments[0] === "record";
	const label =
		job.status === "failed"
			? canRetry
				? "Upload paused · Tap to retry"
				: "Recording could not be recovered"
			: job.status === "processing"
				? "Creating your share link"
				: job.status === "complete"
					? "Recording ready"
					: `Uploading recording · ${percent}%`;
	const symbol =
		job.status === "failed"
			? "exclamationmark.icloud.fill"
			: job.status === "complete"
				? "checkmark.icloud.fill"
				: "icloud.and.arrow.up.fill";

	return (
		<View pointerEvents="box-none" style={styles.container}>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={label}
				onPress={() => {
					if (canRetry) retryRecording(job.id);
					else if (job.status === "complete") {
						router.push({ pathname: "/caps/[id]", params: { id: job.id } });
					}
				}}
				style={({ pressed }) => [
					styles.pill,
					isRecorder
						? { top: insets.top + 62 }
						: { bottom: insets.bottom + 82 },
					pressed ? styles.pillPressed : null,
				]}
			>
				<SymbolView name={symbol} size={16} tintColor={colors.white} />
				<Text numberOfLines={1} style={styles.label}>
					{label}
				</Text>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		...StyleSheet.absoluteFillObject,
		zIndex: 100,
		alignItems: "center",
		justifyContent: "flex-end",
	},
	pill: {
		position: "absolute",
		maxWidth: "88%",
		height: 42,
		paddingHorizontal: 15,
		borderRadius: radius.full,
		borderCurve: "continuous",
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		backgroundColor: "rgba(18,18,20,0.9)",
		boxShadow: "0 5px 18px rgba(0,0,0,0.2)",
	},
	pillPressed: {
		opacity: 0.82,
		transform: [{ scale: 0.98 }],
	},
	label: {
		color: colors.white,
		fontFamily: fonts.medium,
		fontSize: 14,
	},
});

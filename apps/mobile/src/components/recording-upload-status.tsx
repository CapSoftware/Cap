import * as Haptics from "expo-haptics";
import { router, useSegments } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
	useAnimatedStyle,
	useSharedValue,
	withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/auth/AuthContext";
import {
	UPLOAD_CARD_HEIGHT,
	UploadStackCard,
} from "@/components/recording-upload-card";
import { colors, fonts, radius } from "@/theme";
import {
	useRecordingUploadActions,
	useRecordingUploadDisplayQueue,
} from "@/uploads/recording-upload-provider";
import type { RecordingUploadJob } from "@/uploads/recording-upload-queue";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const EXPAND_SPRING = { damping: 20, mass: 0.7, stiffness: 220 };

export function RecordingUploadStatus() {
	const insets = useSafeAreaInsets();
	const auth = useAuth();
	const segments = useSegments();
	const queue = useRecordingUploadDisplayQueue();
	const { retryRecording, discardRecording, dismissRecording } =
		useRecordingUploadActions();
	const [expanded, setExpanded] = useState(false);
	const expandProgress = useSharedValue(0);
	const previousStatuses = useRef(
		new Map<string, RecordingUploadJob["status"]>(),
	);

	const isRecorder = segments[0] === "record";
	const cards = [...queue.jobs].reverse();
	const total = cards.length;

	useEffect(() => {
		for (const job of queue.jobs) {
			const previous = previousStatuses.current.get(job.id);
			if (previous !== "complete" && job.status === "complete") {
				void Haptics.notificationAsync(
					Haptics.NotificationFeedbackType.Success,
				);
			}
			previousStatuses.current.set(job.id, job.status);
		}
		for (const id of [...previousStatuses.current.keys()]) {
			if (!queue.jobs.some((job) => job.id === id)) {
				previousStatuses.current.delete(id);
			}
		}
	}, [queue.jobs]);

	useEffect(() => {
		expandProgress.value = withSpring(expanded ? 1 : 0, EXPAND_SPRING);
	}, [expanded, expandProgress]);

	useEffect(() => {
		if (expanded && (isRecorder || total <= 1)) setExpanded(false);
	}, [expanded, isRecorder, total]);

	const openCap = useCallback((id: string) => {
		setExpanded(false);
		router.push({ pathname: "/caps/[id]", params: { id } });
	}, []);
	const collapse = useCallback(() => setExpanded(false), []);
	const expand = useCallback(() => setExpanded(true), []);

	const scrimStyle = useAnimatedStyle(() => ({
		opacity: expandProgress.value,
	}));
	const badgeStyle = useAnimatedStyle(() => ({
		opacity: 1 - expandProgress.value,
	}));

	if (auth.status !== "signedIn" || total === 0) return null;

	const visible = isRecorder
		? cards.slice(0, 1)
		: expanded
			? cards
			: cards.slice(0, 3);

	return (
		<View pointerEvents="box-none" style={styles.overlay}>
			{isRecorder ? null : (
				<AnimatedPressable
					accessibilityLabel="Collapse uploads"
					accessibilityRole="button"
					onPress={collapse}
					pointerEvents={expanded ? "auto" : "none"}
					style={[styles.scrim, scrimStyle]}
				/>
			)}
			<View
				pointerEvents="box-none"
				style={[
					styles.anchor,
					isRecorder
						? { top: insets.top + 62 }
						: { bottom: insets.bottom + 96 },
				]}
			>
				{visible.map((job, index) => (
					<UploadStackCard
						key={job.id}
						expandProgress={expandProgress}
						expanded={isRecorder ? false : expanded}
						index={index}
						job={job}
						onDiscard={discardRecording}
						onDismiss={dismissRecording}
						onOpen={openCap}
						onRequestExpand={expand}
						onRetry={retryRecording}
						total={isRecorder ? 1 : total}
					/>
				))}
				{isRecorder || total <= 3 ? null : (
					<Animated.View
						pointerEvents="none"
						style={[styles.badge, badgeStyle]}
					>
						<Text style={styles.badgeText}>+{total - 3}</Text>
					</Animated.View>
				)}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	overlay: {
		...StyleSheet.absoluteFillObject,
		zIndex: 100,
	},
	scrim: {
		...StyleSheet.absoluteFillObject,
		backgroundColor: "rgba(0,0,0,0.28)",
	},
	anchor: {
		position: "absolute",
		left: 16,
		right: 16,
		height: UPLOAD_CARD_HEIGHT,
	},
	badge: {
		position: "absolute",
		top: -10,
		right: 4,
		minWidth: 24,
		height: 20,
		paddingHorizontal: 7,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(18,18,20,0.92)",
	},
	badgeText: {
		color: colors.white,
		fontFamily: fonts.medium,
		fontSize: 11,
		fontVariant: ["tabular-nums"],
	},
});

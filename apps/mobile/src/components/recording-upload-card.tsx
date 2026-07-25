import {
	GlassView,
	isGlassEffectAPIAvailable,
	isLiquidGlassAvailable,
} from "expo-glass-effect";
import { type SFSymbol, SymbolView } from "expo-symbols";
import { useEffect } from "react";
import {
	Dimensions,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
	Extrapolation,
	FadeOut,
	interpolate,
	runOnJS,
	type SharedValue,
	SlideInDown,
	useAnimatedStyle,
	useSharedValue,
	withSpring,
	withTiming,
} from "react-native-reanimated";
import { colors, fonts, radius, squircle } from "@/theme";
import {
	type RecordingUploadJob,
	recordingUploadProgress,
} from "@/uploads/recording-upload-queue";

export const UPLOAD_CARD_HEIGHT = 64;
const CARD_GAP = 10;
const PEEK_OFFSET = 8;
const SCALE_STEP = 0.05;
const STACK_DEPTH = 2;
const SCREEN_WIDTH = Dimensions.get("window").width;
const DISMISS_THRESHOLD = SCREEN_WIDTH * 0.32;
const DARK_TINT = "rgba(18,18,20,0.55)";
const STACK_SPRING = { damping: 20, mass: 0.7, stiffness: 220 };
const PROGRESS_SPRING = { damping: 22, mass: 0.6, stiffness: 140 };

const glassAvailable = (() => {
	if (Platform.OS !== "ios") return false;
	try {
		return isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
	} catch {
		return false;
	}
})();

type UploadCardKind =
	| "recording"
	| "uploading"
	| "processing"
	| "complete"
	| "retryable"
	| "unrecoverable";

type UploadCardDescriptor = {
	kind: UploadCardKind;
	title: string;
	symbol: SFSymbol;
	symbolColor: string;
	barColor: string;
};

const describeJob = (job: RecordingUploadJob): UploadCardDescriptor => {
	if (job.status === "recording" && job.uploadOwner === "external") {
		return {
			kind: "recording",
			title: "Screen recording in progress",
			symbol: "rectangle.fill.on.rectangle.fill",
			symbolColor: colors.red9,
			barColor: colors.red9,
		};
	}
	if (job.status === "complete") {
		return {
			kind: "complete",
			title: "Recording ready · Tap to view",
			symbol: "checkmark.icloud.fill",
			symbolColor: colors.green9,
			barColor: colors.green9,
		};
	}
	if (job.status === "failed") {
		if (job.durationSeconds !== null && job.uploadOwner === "app") {
			return {
				kind: "retryable",
				title: "Upload paused · Tap to retry",
				symbol: "exclamationmark.icloud.fill",
				symbolColor: colors.yellow9,
				barColor: colors.yellow9,
			};
		}
		return {
			kind: "unrecoverable",
			title: "Recording could not be recovered",
			symbol: "exclamationmark.icloud.fill",
			symbolColor: colors.red9,
			barColor: colors.red9,
		};
	}
	if (job.status === "processing") {
		const title =
			job.processingMessage ??
			(job.serverPhase === "generating_thumbnail" ||
			job.serverPhase === "complete"
				? "Finishing up"
				: job.serverPhase === "processing"
					? "Processing"
					: "Finishing your recording");
		return {
			kind: "processing",
			title,
			symbol: "icloud.and.arrow.up.fill",
			symbolColor: colors.white,
			barColor: colors.blue9,
		};
	}
	const percent = Math.round(recordingUploadProgress(job) * 100);
	return {
		kind: "uploading",
		title: `Uploading · ${percent}%`,
		symbol: "icloud.and.arrow.up.fill",
		symbolColor: colors.white,
		barColor: colors.blue9,
	};
};

type UploadStackCardProps = {
	job: RecordingUploadJob;
	index: number;
	total: number;
	expanded: boolean;
	expandProgress: SharedValue<number>;
	onRequestExpand: () => void;
	onOpen: (id: string) => void;
	onRetry: (id: string) => void;
	onDiscard: (id: string) => void;
	onDismiss: (id: string) => void;
};

export function UploadStackCard({
	job,
	index,
	total,
	expanded,
	expandProgress,
	onRequestExpand,
	onOpen,
	onRetry,
	onDiscard,
	onDismiss,
}: UploadStackCardProps) {
	const descriptor = describeJob(job);
	const fraction =
		descriptor.kind === "complete" || descriptor.kind === "recording"
			? 1
			: recordingUploadProgress(job);
	const interactive = expanded || index === 0;
	const canSwipe = interactive && descriptor.kind === "complete";
	const translateX = useSharedValue(0);
	const indexValue = useSharedValue(index);
	const progress = useSharedValue(fraction);

	useEffect(() => {
		indexValue.value = withSpring(index, STACK_SPRING);
	}, [index, indexValue]);

	useEffect(() => {
		progress.value = withSpring(fraction, PROGRESS_SPRING);
	}, [fraction, progress]);

	const cardStyle = useAnimatedStyle(() => {
		const idx = indexValue.value;
		const openness = expandProgress.value;
		const collapsedY = interpolate(
			idx,
			[0, STACK_DEPTH],
			[0, STACK_DEPTH * PEEK_OFFSET],
			Extrapolation.CLAMP,
		);
		const collapsedScale = interpolate(
			idx,
			[0, STACK_DEPTH],
			[1, 1 - STACK_DEPTH * SCALE_STEP],
			Extrapolation.CLAMP,
		);
		const collapsedOpacity = interpolate(
			idx,
			[0, 1, 2, 3],
			[1, 0.6, 0.42, 0],
			Extrapolation.CLAMP,
		);
		const expandedY = -idx * (UPLOAD_CARD_HEIGHT + CARD_GAP);
		const translateY = collapsedY + (expandedY - collapsedY) * openness;
		const scale = collapsedScale + (1 - collapsedScale) * openness;
		const opacity = collapsedOpacity + (1 - collapsedOpacity) * openness;
		const swipeFade =
			1 - Math.min(1, Math.abs(translateX.value) / SCREEN_WIDTH);
		return {
			opacity: opacity * swipeFade,
			transform: [{ translateY }, { translateX: translateX.value }, { scale }],
		};
	});

	const barStyle = useAnimatedStyle(() => ({
		transform: [{ scaleX: Math.max(0.0001, progress.value) }],
	}));

	const handlePress = () => {
		if (!expanded && total > 1) {
			onRequestExpand();
			return;
		}
		if (descriptor.kind === "complete") onOpen(job.id);
		else if (descriptor.kind === "retryable") onRetry(job.id);
	};

	const pan = Gesture.Pan()
		.enabled(canSwipe)
		.activeOffsetX([-14, 14])
		.failOffsetY([-12, 12])
		.onUpdate((event) => {
			translateX.value = event.translationX;
		})
		.onEnd((event) => {
			if (Math.abs(event.translationX) > DISMISS_THRESHOLD) {
				translateX.value = withTiming(
					Math.sign(event.translationX) * SCREEN_WIDTH,
					{ duration: 180 },
					(finished) => {
						if (finished) runOnJS(onDismiss)(job.id);
					},
				);
				return;
			}
			translateX.value = withSpring(0, STACK_SPRING);
		});

	return (
		<Animated.View
			entering={SlideInDown.springify().damping(20).mass(0.7)}
			exiting={FadeOut.duration(180)}
			pointerEvents="box-none"
			style={[styles.slot, { zIndex: total - index }]}
		>
			<GestureDetector gesture={pan}>
				<Animated.View
					pointerEvents={interactive ? "auto" : "none"}
					style={[styles.card, cardStyle]}
				>
					<Pressable
						accessibilityLabel={descriptor.title}
						accessibilityRole="button"
						onPress={handlePress}
						style={styles.pressable}
					>
						{glassAvailable ? (
							<GlassView
								colorScheme="dark"
								glassEffectStyle="regular"
								style={StyleSheet.absoluteFill}
								tintColor={DARK_TINT}
							/>
						) : (
							<View style={[StyleSheet.absoluteFill, styles.fallback]} />
						)}
						<View pointerEvents="none" style={styles.border} />
						<View style={styles.content}>
							<View style={styles.row}>
								<SymbolView
									name={descriptor.symbol}
									size={20}
									tintColor={descriptor.symbolColor}
								/>
								<Text numberOfLines={1} style={styles.title}>
									{descriptor.title}
								</Text>
								{descriptor.kind === "unrecoverable" && interactive ? (
									<Pressable
										accessibilityLabel="Discard recording"
										accessibilityRole="button"
										hitSlop={10}
										onPress={() => onDiscard(job.id)}
										style={styles.discard}
									>
										<SymbolView
											name="xmark"
											size={12}
											tintColor={colors.white}
											weight="bold"
										/>
									</Pressable>
								) : null}
							</View>
							<View style={styles.track}>
								<Animated.View
									style={[
										styles.bar,
										{ backgroundColor: descriptor.barColor },
										barStyle,
									]}
								/>
							</View>
						</View>
					</Pressable>
				</Animated.View>
			</GestureDetector>
		</Animated.View>
	);
}

const styles = StyleSheet.create({
	slot: {
		position: "absolute",
		left: 0,
		right: 0,
		top: 0,
		height: UPLOAD_CARD_HEIGHT,
	},
	card: {
		height: UPLOAD_CARD_HEIGHT,
		borderRadius: radius.lg,
		boxShadow: "0 12px 30px rgba(0,0,0,0.32)",
		...squircle,
	},
	pressable: {
		flex: 1,
		borderRadius: radius.lg,
		overflow: "hidden",
		...squircle,
	},
	fallback: {
		backgroundColor: "rgba(18,18,20,0.92)",
	},
	border: {
		...StyleSheet.absoluteFillObject,
		borderRadius: radius.lg,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(255,255,255,0.14)",
		...squircle,
	},
	content: {
		flex: 1,
		paddingHorizontal: 14,
		paddingVertical: 11,
		justifyContent: "center",
		gap: 9,
	},
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
	},
	title: {
		flex: 1,
		color: colors.white,
		fontFamily: fonts.medium,
		fontSize: 14.5,
		fontVariant: ["tabular-nums"],
	},
	discard: {
		width: 22,
		height: 22,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(255,255,255,0.12)",
	},
	track: {
		height: 3,
		borderRadius: radius.full,
		backgroundColor: "rgba(255,255,255,0.16)",
		overflow: "hidden",
	},
	bar: {
		position: "absolute",
		left: 0,
		top: 0,
		bottom: 0,
		width: "100%",
		borderRadius: radius.full,
		transformOrigin: "left",
	},
});

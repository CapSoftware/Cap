import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useState } from "react";
import {
	type LayoutChangeEvent,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import Animated, {
	cancelAnimation,
	Easing,
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";
import { fonts, radius, squircle } from "@/theme";
import {
	calculatePlaybackDurationMs,
	calculateRemainingPlaybackDurationMs,
} from "./teleprompter";

type TeleprompterOverlayProps = {
	script: string;
	fontSize: number;
	wordsPerMinute: number;
	playing: boolean;
	restartKey: number;
	onTogglePlayback: () => void;
};

export function TeleprompterOverlay({
	script,
	fontSize,
	wordsPerMinute,
	playing,
	restartKey,
	onTogglePlayback,
}: TeleprompterOverlayProps) {
	const [viewportHeight, setViewportHeight] = useState(0);
	const [textHeight, setTextHeight] = useState(0);
	const progress = useSharedValue(0);
	const lineHeight = Math.round(fontSize * 1.42);
	const travelDistance = Math.max(0, textHeight - lineHeight);
	const totalDurationMs = useMemo(
		() => calculatePlaybackDurationMs(script, wordsPerMinute),
		[script, wordsPerMinute],
	);

	useEffect(() => {
		if (restartKey < 0) return;
		cancelAnimation(progress);
		progress.value = 0;
	}, [progress, restartKey]);

	useEffect(() => {
		if (
			restartKey < 0 ||
			!playing ||
			travelDistance <= 1 ||
			totalDurationMs === 0
		) {
			cancelAnimation(progress);
			return;
		}

		if (progress.value >= 0.999) progress.value = 0;
		const duration = calculateRemainingPlaybackDurationMs(
			totalDurationMs,
			progress.value,
		);
		progress.value = withTiming(1, {
			duration,
			easing: Easing.linear,
		});
	}, [playing, progress, restartKey, totalDurationMs, travelDistance]);

	const textStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: -travelDistance * progress.value }],
	}));

	const onViewportLayout = (event: LayoutChangeEvent) => {
		setViewportHeight(event.nativeEvent.layout.height);
	};

	const onTextLayout = (event: LayoutChangeEvent) => {
		cancelAnimation(progress);
		progress.value = 0;
		setTextHeight(event.nativeEvent.layout.height);
	};

	return (
		<View
			accessibilityLabel="Teleprompter"
			onLayout={onViewportLayout}
			style={styles.container}
		>
			<View pointerEvents="none" style={styles.centerGuide}>
				<SymbolView
					name="chevron.right"
					size={15}
					tintColor="rgba(255,255,255,0.72)"
					weight="bold"
				/>
				<View style={styles.guideLine} />
				<SymbolView
					name="chevron.left"
					size={15}
					tintColor="rgba(255,255,255,0.72)"
					weight="bold"
				/>
			</View>
			<Animated.View
				pointerEvents="none"
				style={[
					styles.script,
					{
						top: Math.max(0, (viewportHeight - lineHeight) / 2),
					},
					textStyle,
				]}
			>
				<Text
					onLayout={onTextLayout}
					style={[styles.scriptText, { fontSize, lineHeight }]}
				>
					{script.trim()}
				</Text>
			</Animated.View>
			<View pointerEvents="none" style={styles.topFade} />
			<View pointerEvents="none" style={styles.bottomFade} />
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={
					playing ? "Pause teleprompter" : "Play teleprompter"
				}
				hitSlop={8}
				onPress={onTogglePlayback}
				style={({ pressed }) => [
					styles.playbackButton,
					pressed ? styles.playbackButtonPressed : null,
				]}
			>
				<SymbolView
					name={playing ? "pause.fill" : "play.fill"}
					size={13}
					tintColor="rgba(255,255,255,0.9)"
					weight="semibold"
				/>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		position: "absolute",
		top: 106,
		left: 14,
		right: 14,
		height: "43%",
		borderRadius: radius.xl,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(255,255,255,0.16)",
		backgroundColor: "rgba(8,10,14,0.28)",
		overflow: "hidden",
		...squircle,
	},
	centerGuide: {
		position: "absolute",
		zIndex: 2,
		left: 9,
		right: 9,
		top: "50%",
		flexDirection: "row",
		alignItems: "center",
		gap: 7,
		transform: [{ translateY: -8 }],
	},
	guideLine: {
		flex: 1,
		height: StyleSheet.hairlineWidth,
		backgroundColor: "rgba(255,255,255,0.18)",
	},
	script: {
		position: "absolute",
		left: 28,
		right: 28,
	},
	scriptText: {
		fontFamily: fonts.medium,
		color: "rgba(255,255,255,0.9)",
		textAlign: "center",
		letterSpacing: -0.6,
		textShadowColor: "rgba(0,0,0,0.34)",
		textShadowOffset: { width: 0, height: 1 },
		textShadowRadius: 4,
	},
	topFade: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		height: 36,
		backgroundColor: "rgba(8,10,14,0.34)",
	},
	bottomFade: {
		position: "absolute",
		bottom: 0,
		left: 0,
		right: 0,
		height: 42,
		backgroundColor: "rgba(8,10,14,0.34)",
	},
	playbackButton: {
		position: "absolute",
		right: 10,
		bottom: 9,
		zIndex: 3,
		width: 34,
		height: 34,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(0,0,0,0.42)",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(255,255,255,0.18)",
	},
	playbackButtonPressed: {
		opacity: 0.72,
	},
});

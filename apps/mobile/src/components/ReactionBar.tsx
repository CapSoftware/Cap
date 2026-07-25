import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type LayoutChangeEvent,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import Animated, {
	FadeIn,
	runOnJS,
	useAnimatedStyle,
	useSharedValue,
	withSequence,
	withSpring,
	withTiming,
} from "react-native-reanimated";
import { colors, fonts, radius, squircle } from "@/theme";
import { GlassSurface } from "./GlassSurface";

export type ReactionCount = {
	emoji: string;
	count: number;
};

type FloatingReaction = {
	id: number;
	emoji: string;
	x: number;
	drift: number;
	rotate: number;
};

const bumpSpring = { damping: 9, stiffness: 260, mass: 0.6 };
const floatDistance = 184;
const floatDuration = 1200;

type CountPillProps = {
	emoji: string;
	count: number;
};

function CountPill({ emoji, count }: CountPillProps) {
	const scale = useSharedValue(1);
	const previous = useRef(count);

	useEffect(() => {
		if (count > previous.current) {
			scale.value = withSequence(
				withSpring(1.32, bumpSpring),
				withSpring(1, bumpSpring),
			);
		}
		previous.current = count;
	}, [count, scale]);

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [{ scale: scale.value }],
	}));

	return (
		<Animated.View
			entering={FadeIn.duration(180)}
			style={[styles.countPill, animatedStyle]}
		>
			<Text allowFontScaling={false} style={styles.countPillEmoji}>
				{emoji}
			</Text>
			<Text allowFontScaling={false} style={styles.countPillValue}>
				{count}
			</Text>
		</Animated.View>
	);
}

type ReactionOptionProps = {
	emoji: string;
	disabled: boolean;
	onPress: (emoji: string, centerX: number) => void;
};

function ReactionOption({ emoji, disabled, onPress }: ReactionOptionProps) {
	const scale = useSharedValue(1);
	const center = useRef(0);

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [{ scale: scale.value }],
	}));

	const onLayout = (event: LayoutChangeEvent) => {
		const { x, width } = event.nativeEvent.layout;
		center.current = x + width / 2;
	};

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={`React with ${emoji}`}
			accessibilityHint="Adds this reaction"
			accessibilityState={{ disabled }}
			disabled={disabled}
			hitSlop={6}
			onLayout={onLayout}
			onPress={() => {
				scale.value = withSequence(
					withSpring(1.36, bumpSpring),
					withSpring(1, bumpSpring),
				);
				onPress(emoji, center.current);
			}}
			style={styles.option}
		>
			<Animated.View style={animatedStyle}>
				<Text allowFontScaling={false} style={styles.optionEmoji}>
					{emoji}
				</Text>
			</Animated.View>
		</Pressable>
	);
}

type FloatingEmojiProps = {
	reaction: FloatingReaction;
	onDone: (id: number) => void;
};

function FloatingEmoji({ reaction, onDone }: FloatingEmojiProps) {
	const progress = useSharedValue(0);

	useEffect(() => {
		progress.value = withTiming(1, { duration: floatDuration }, (finished) => {
			if (finished) runOnJS(onDone)(reaction.id);
		});
	}, [progress, onDone, reaction.id]);

	const animatedStyle = useAnimatedStyle(() => ({
		opacity: 1 - progress.value,
		transform: [
			{ translateY: -floatDistance * progress.value },
			{ translateX: reaction.drift * progress.value },
			{ rotate: `${reaction.rotate * progress.value}deg` },
			{ scale: 1 + progress.value * 0.4 },
		],
	}));

	return (
		<Animated.View
			pointerEvents="none"
			style={[styles.floating, { left: reaction.x - 14 }, animatedStyle]}
		>
			<Text allowFontScaling={false} style={styles.floatingEmoji}>
				{reaction.emoji}
			</Text>
		</Animated.View>
	);
}

type ReactionBarProps = {
	options: readonly string[];
	counts: ReactionCount[];
	total: number;
	onReact: (emoji: string) => void;
	disabled?: boolean;
};

export function ReactionBar({
	options,
	counts,
	total,
	onReact,
	disabled = false,
}: ReactionBarProps) {
	const [floats, setFloats] = useState<FloatingReaction[]>([]);
	const nextId = useRef(0);

	const removeFloat = useCallback((id: number) => {
		setFloats((current) => current.filter((item) => item.id !== id));
	}, []);

	const spawnFloats = (emoji: string, centerX: number) => {
		const burst = 3 + Math.floor(Math.random() * 3);
		const additions: FloatingReaction[] = [];
		for (let index = 0; index < burst; index += 1) {
			nextId.current += 1;
			additions.push({
				id: nextId.current,
				emoji,
				x: centerX,
				drift: (Math.random() - 0.5) * 84,
				rotate: (Math.random() - 0.5) * 44,
			});
		}
		setFloats((current) => [...current, ...additions]);
	};

	const handlePress = (emoji: string, centerX: number) => {
		void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
		spawnFloats(emoji, centerX);
		onReact(emoji);
	};

	return (
		<View style={styles.container}>
			<View style={styles.header}>
				<Text style={styles.title}>Reactions</Text>
				<Text style={styles.count}>{total}</Text>
			</View>
			{counts.length > 0 ? (
				<View style={styles.countRow}>
					{counts.map((item) => (
						<CountPill count={item.count} emoji={item.emoji} key={item.emoji} />
					))}
				</View>
			) : (
				<Text style={styles.emptyText}>Be the first to react.</Text>
			)}
			<View style={styles.optionsWrapper}>
				<View pointerEvents="none" style={styles.floatLayer}>
					{floats.map((item) => (
						<FloatingEmoji key={item.id} onDone={removeFloat} reaction={item} />
					))}
				</View>
				<GlassSurface
					fallbackStyle={styles.optionsFallback}
					isInteractive
					style={styles.options}
					tintColor={colors.gray1}
				>
					{options.map((emoji) => (
						<ReactionOption
							disabled={disabled}
							emoji={emoji}
							key={emoji}
							onPress={handlePress}
						/>
					))}
				</GlassSurface>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		backgroundColor: colors.gray1,
		gap: 12,
		padding: 16,
		...squircle,
	},
	header: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	title: {
		fontFamily: fonts.medium,
		fontSize: 18,
		lineHeight: 23,
		color: colors.gray12,
	},
	count: {
		fontFamily: fonts.medium,
		fontSize: 14,
		color: colors.gray10,
	},
	emptyText: {
		fontFamily: fonts.regular,
		fontSize: 14,
		color: colors.gray10,
	},
	countRow: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
	},
	countPill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		minHeight: 32,
		borderRadius: radius.full,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		backgroundColor: colors.gray2,
		paddingHorizontal: 11,
		...squircle,
	},
	countPillEmoji: {
		fontSize: 15,
	},
	countPillValue: {
		fontFamily: fonts.medium,
		fontSize: 14,
		color: colors.gray12,
	},
	optionsWrapper: {
		position: "relative",
	},
	floatLayer: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		zIndex: 4,
	},
	floating: {
		position: "absolute",
		top: 4,
		width: 28,
		alignItems: "center",
	},
	floatingEmoji: {
		fontSize: 24,
	},
	options: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		borderRadius: radius.full,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		paddingHorizontal: 6,
		paddingVertical: 6,
		...squircle,
	},
	optionsFallback: {
		backgroundColor: colors.gray2,
	},
	option: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		paddingVertical: 8,
	},
	optionEmoji: {
		fontSize: 24,
	},
});

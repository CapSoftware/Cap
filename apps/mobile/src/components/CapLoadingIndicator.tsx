import { useEffect, useMemo } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
	cancelAnimation,
	Easing,
	useAnimatedStyle,
	useReducedMotion,
	useSharedValue,
	withRepeat,
	withSequence,
	withTiming,
} from "react-native-reanimated";
import { colors } from "@/theme";

const LOGO_BLUE = "#4785FF";
const LOGO_LIGHT_BLUE = "#ADC9FF";
// Ring proportions from assets/splash-icon.svg (circle radii 248/202/156).
const MIDDLE_RATIO = 202 / 248;
const INNER_RATIO = 156 / 248;

const TILT_MAX_DEG = 16;
const ROCK_OUT_MS = 130;
const ROCK_BACK_MS = 180;
const ROCK_BEAT_MS = 210;
const TREMBLE_STEP_MS = 45;
const REST_MS = 650;
// Both loops must span the exact same total or they drift apart over repeats:
// tilt = 2×(130+180+210) + 8×45 + 650 = 2050
// swell = 1040 + 360 + 90 + 160 + 400 = 2050

function rockAndTremble() {
	const out = { duration: ROCK_OUT_MS, easing: Easing.out(Easing.quad) };
	const back = { duration: ROCK_BACK_MS, easing: Easing.inOut(Easing.quad) };
	const step = { duration: TREMBLE_STEP_MS };
	return withRepeat(
		withSequence(
			withTiming(-TILT_MAX_DEG, out),
			withTiming(0, back),
			withTiming(0, { duration: ROCK_BEAT_MS }),
			withTiming(TILT_MAX_DEG, out),
			withTiming(0, back),
			withTiming(0, { duration: ROCK_BEAT_MS }),
			withTiming(-4, step),
			withTiming(4.5, step),
			withTiming(-5.5, step),
			withTiming(6, step),
			withTiming(-6.5, step),
			withTiming(7, step),
			withTiming(-5, step),
			withTiming(0, step),
			withTiming(0, { duration: REST_MS }),
		),
		-1,
	);
}

function swellAndPop() {
	return withRepeat(
		withSequence(
			withTiming(1, { duration: 1040 }),
			withTiming(1.07, { duration: 360, easing: Easing.in(Easing.quad) }),
			withTiming(0.96, { duration: 90, easing: Easing.out(Easing.quad) }),
			withTiming(1, { duration: 160, easing: Easing.out(Easing.quad) }),
			withTiming(1, { duration: 400 }),
		),
		-1,
	);
}

type CapLoadingIndicatorProps = {
	size?: number;
};

export function CapLoadingIndicator({ size = 56 }: CapLoadingIndicatorProps) {
	const reduceMotion = useReducedMotion();
	const tilt = useSharedValue(0);
	const swell = useSharedValue(1);
	const pulse = useSharedValue(0);

	useEffect(() => {
		if (reduceMotion) {
			pulse.value = 0;
			pulse.value = withRepeat(
				withTiming(1, { duration: 1600, easing: Easing.linear }),
				-1,
			);
			return () => {
				cancelAnimation(pulse);
			};
		}
		tilt.value = 0;
		tilt.value = rockAndTremble();
		swell.value = 1;
		swell.value = swellAndPop();
		return () => {
			cancelAnimation(tilt);
			cancelAnimation(swell);
		};
	}, [reduceMotion, tilt, swell, pulse]);

	// Reduce Motion swaps the wobble for a gentle opacity pulse: a loading
	// state must keep signalling progress, it just shouldn't move.
	const ballStyle = useAnimatedStyle(() => {
		if (reduceMotion) {
			return {
				opacity: 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(2 * Math.PI * pulse.value)),
				transform: [],
			};
		}
		return {
			opacity: 1,
			transform: [
				// translateY sandwich moves the pivot to the ball's bottom edge so
				// it rocks like a ball on the ground instead of spinning in place.
				{ translateY: size / 2 },
				{ rotate: `${tilt.value}deg` },
				{ translateY: -size / 2 },
				{ scale: swell.value },
			],
		};
	});

	const layers = useMemo(() => {
		const circle = (diameter: number, backgroundColor: string): ViewStyle => ({
			backgroundColor,
			borderRadius: diameter / 2,
			height: diameter,
			left: (size - diameter) / 2,
			position: "absolute",
			top: (size - diameter) / 2,
			width: diameter,
		});
		return {
			ball: { height: size, width: size } satisfies ViewStyle,
			inner: circle(size * INNER_RATIO, colors.white),
			middle: circle(size * MIDDLE_RATIO, LOGO_LIGHT_BLUE),
			outer: {
				...circle(size, LOGO_BLUE),
				boxShadow: `0px ${Math.round(size * 0.06)}px ${Math.round(size * 0.25)}px rgba(71, 133, 255, 0.3)`,
			} satisfies ViewStyle,
		};
	}, [size]);

	return (
		<View
			accessible
			accessibilityLabel="Loading"
			accessibilityRole="progressbar"
			style={[styles.wrapper, layers.ball]}
			testID="cap-loading-indicator"
		>
			<Animated.View style={[layers.ball, ballStyle]} testID="cap-loading-ball">
				<View style={layers.outer} testID="cap-loading-circle-outer" />
				<View style={layers.middle} testID="cap-loading-circle-middle" />
				<View style={layers.inner} testID="cap-loading-circle-inner" />
			</Animated.View>
		</View>
	);
}

const styles = StyleSheet.create({
	wrapper: {
		alignItems: "center",
		justifyContent: "center",
		pointerEvents: "none",
	},
});

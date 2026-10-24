import {
	GlassView,
	isGlassEffectAPIAvailable,
	isLiquidGlassAvailable,
} from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { router, useSegments } from "expo-router";
import { type SFSymbol, SymbolView } from "expo-symbols";
import { useEffect } from "react";
import {
	Platform,
	Pressable,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import Animated, {
	cancelAnimation,
	Easing,
	useAnimatedStyle,
	useSharedValue,
	withRepeat,
	withSpring,
	withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, fonts } from "@/theme";

const BAR_HEIGHT = 62;
const BAR_MARGIN = 12;
const RECORD_HEIGHT = 48;
const OVERLAY_SIZE = 96;

const pressSpring = { damping: 18, stiffness: 320, mass: 0.7 } as const;

const glassAvailable = (() => {
	if (Platform.OS !== "ios") return false;
	try {
		return isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
	} catch {
		return false;
	}
})();

type TabDefinition = {
	name: string;
	label: string;
	icon: SFSymbol;
	iconActive: SFSymbol;
};

const leftTab: TabDefinition = {
	name: "index",
	label: "My Caps",
	icon: "folder",
	iconActive: "folder.fill",
};

const rightTab: TabDefinition = {
	name: "account",
	label: "Account",
	icon: "person.crop.circle",
	iconActive: "person.crop.circle.fill",
};

type TabBarProps = {
	activeRouteName: string;
	onSelect: (routeName: string) => void;
};

function TabSlot({
	tab,
	active,
	onSelect,
}: {
	tab: TabDefinition;
	active: boolean;
	onSelect: (routeName: string) => void;
}) {
	const scale = useSharedValue(1);
	const animatedStyle = useAnimatedStyle(() => ({
		transform: [{ scale: scale.value }],
	}));
	const tint = active ? colors.blue9 : colors.gray11;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ selected: active }}
			accessibilityLabel={tab.label}
			onPressIn={() => {
				scale.value = withSpring(0.92, pressSpring);
			}}
			onPressOut={() => {
				scale.value = withSpring(1, pressSpring);
			}}
			onPress={() => {
				void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
				onSelect(tab.name);
			}}
			style={styles.tabSlot}
		>
			<Animated.View style={[styles.tabSlotInner, animatedStyle]}>
				<SymbolView
					name={active ? tab.iconActive : tab.icon}
					size={22}
					tintColor={tint}
					weight="medium"
				/>
				<Text style={[styles.tabLabel, { color: tint }]}>{tab.label}</Text>
			</Animated.View>
		</Pressable>
	);
}

export function TabBar({ activeRouteName, onSelect }: TabBarProps) {
	const insets = useSafeAreaInsets();
	const { width, height } = useWindowDimensions();
	const segments = useSegments();
	const occluded = segments[0] === "record";
	const breathe = useSharedValue(1);
	const pressScale = useSharedValue(1);
	const overlayScale = useSharedValue(0);
	const overlayOpacity = useSharedValue(0);

	useEffect(() => {
		if (occluded) {
			cancelAnimation(breathe);
			breathe.value = 1;
			return;
		}
		breathe.value = withRepeat(
			withTiming(1.025, { duration: 2200, easing: Easing.inOut(Easing.ease) }),
			-1,
			true,
		);
		return () => {
			cancelAnimation(breathe);
		};
	}, [breathe, occluded]);

	const recordStyle = useAnimatedStyle(() => ({
		transform: [{ scale: pressScale.value * breathe.value }],
	}));
	const overlayStyle = useAnimatedStyle(() => ({
		opacity: overlayOpacity.value,
		transform: [{ scale: overlayScale.value }],
	}));

	const overlayTarget = Math.ceil(
		(Math.hypot(width, height) * 2.2) / OVERLAY_SIZE,
	);

	const launchRecorder = () => {
		void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
		overlayOpacity.value = 1;
		overlayScale.value = 0;
		overlayScale.value = withTiming(overlayTarget, {
			duration: 280,
			easing: Easing.out(Easing.cubic),
		});
		setTimeout(() => {
			router.push("/record");
		}, 220);
		setTimeout(() => {
			overlayOpacity.value = withTiming(0, { duration: 240 }, (finished) => {
				if (finished) {
					overlayScale.value = 0;
				}
			});
		}, 420);
	};

	return (
		<View
			pointerEvents="box-none"
			style={[styles.wrapper, { paddingBottom: insets.bottom + 8 }]}
		>
			<View pointerEvents="box-none" style={styles.stage}>
				<GlassView
					colorScheme="light"
					glassEffectStyle="regular"
					isInteractive
					style={[styles.bar, glassAvailable ? null : styles.barFallback]}
					tintColor="rgba(252, 252, 252, 0.4)"
				>
					<TabSlot
						tab={leftTab}
						active={activeRouteName === leftTab.name}
						onSelect={onSelect}
					/>
					<Animated.View style={[styles.recordGlow, recordStyle]}>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Record"
							accessibilityHint="Opens the camera recorder"
							hitSlop={10}
							onPressIn={() => {
								void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
								pressScale.value = withSpring(0.94, pressSpring);
							}}
							onPressOut={() => {
								pressScale.value = withSpring(1, pressSpring);
							}}
							onPress={launchRecorder}
							style={styles.record}
						>
							<SymbolView
								name="video.fill"
								size={20}
								tintColor={colors.white}
								weight="medium"
							/>
							<Text style={styles.recordLabel}>Record</Text>
						</Pressable>
					</Animated.View>
					<TabSlot
						tab={rightTab}
						active={activeRouteName === rightTab.name}
						onSelect={onSelect}
					/>
				</GlassView>
				<Animated.View
					pointerEvents="none"
					style={[styles.overlay, overlayStyle]}
				/>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	wrapper: {
		position: "absolute",
		left: 0,
		right: 0,
		bottom: 0,
	},
	stage: {
		marginHorizontal: BAR_MARGIN,
		alignItems: "center",
		justifyContent: "center",
	},
	bar: {
		alignSelf: "stretch",
		height: BAR_HEIGHT,
		borderRadius: BAR_HEIGHT / 2,
		borderCurve: "continuous",
		overflow: "hidden",
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 10,
		gap: 6,
	},
	barFallback: {
		backgroundColor: "rgba(252, 252, 252, 0.94)",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(0, 0, 0, 0.08)",
	},
	tabSlot: {
		flex: 1,
		height: "100%",
		alignItems: "center",
		justifyContent: "center",
	},
	tabSlotInner: {
		alignItems: "center",
		justifyContent: "center",
		gap: 2,
	},
	tabLabel: {
		fontFamily: fonts.medium,
		fontSize: 11,
		lineHeight: 13,
	},
	recordGlow: {
		shadowColor: "#ff3b30",
		shadowOffset: { width: 0, height: 4 },
		shadowOpacity: 0.32,
		shadowRadius: 10,
		elevation: 10,
	},
	record: {
		height: RECORD_HEIGHT,
		minWidth: 118,
		borderRadius: RECORD_HEIGHT / 2,
		borderCurve: "continuous",
		paddingHorizontal: 22,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 7,
		backgroundColor: "#ff3b30",
	},
	recordLabel: {
		fontFamily: fonts.medium,
		fontSize: 14,
		lineHeight: 18,
		color: colors.white,
	},
	overlay: {
		position: "absolute",
		left: "50%",
		top: "50%",
		marginLeft: -OVERLAY_SIZE / 2,
		marginTop: -OVERLAY_SIZE / 2,
		width: OVERLAY_SIZE,
		height: OVERLAY_SIZE,
		borderRadius: OVERLAY_SIZE / 2,
		backgroundColor: "#050505",
	},
});

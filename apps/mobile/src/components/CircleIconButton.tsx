import { type SFSymbol, SymbolView } from "expo-symbols";
import {
	type AccessibilityValue,
	ActivityIndicator,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import Animated, {
	useAnimatedStyle,
	useSharedValue,
	withSpring,
} from "react-native-reanimated";
import { colors, fonts, squircle } from "@/theme";
import { GlassSurface } from "./GlassSurface";

const pressSpring = { damping: 18, stiffness: 320, mass: 0.7 };

type CircleIconButtonProps = {
	symbol: SFSymbol;
	accessibilityLabel: string;
	accessibilityHint?: string;
	accessibilityValue?: AccessibilityValue;
	onPress: () => void;
	caption?: string;
	disabled?: boolean;
	loading?: boolean;
	active?: boolean;
	tone?: "neutral" | "accent";
	size?: number;
};

export function CircleIconButton({
	symbol,
	accessibilityLabel,
	accessibilityHint,
	accessibilityValue,
	onPress,
	caption,
	disabled = false,
	loading = false,
	active = false,
	tone = "neutral",
	size = 54,
}: CircleIconButtonProps) {
	const isDisabled = disabled || loading;
	const scale = useSharedValue(1);

	const circleStyle = useAnimatedStyle(() => ({
		transform: [{ scale: scale.value }],
	}));

	const iconColor = active
		? colors.green9
		: tone === "accent"
			? colors.blue11
			: colors.gray12;

	return (
		<View style={styles.wrapper}>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={accessibilityLabel}
				accessibilityHint={accessibilityHint}
				accessibilityValue={accessibilityValue}
				accessibilityState={{ busy: loading, disabled: isDisabled }}
				disabled={isDisabled}
				hitSlop={8}
				onPress={onPress}
				onPressIn={() => {
					scale.value = withSpring(0.94, pressSpring);
				}}
				onPressOut={() => {
					scale.value = withSpring(1, pressSpring);
				}}
			>
				<Animated.View
					style={[
						styles.circle,
						{ width: size, height: size, borderRadius: size / 2 },
						active ? styles.circleActive : null,
						isDisabled ? styles.circleDisabled : null,
						circleStyle,
					]}
				>
					<GlassSurface
						fallbackStyle={styles.glassFallback}
						glassEffectStyle="clear"
						isInteractive
						style={styles.glass}
						tintColor={active ? colors.green9 : colors.glass}
					>
						{loading ? (
							<ActivityIndicator color={iconColor} />
						) : (
							<SymbolView
								name={active ? "checkmark" : symbol}
								size={Math.round(size * 0.4)}
								tintColor={isDisabled ? colors.gray8 : iconColor}
								type="monochrome"
								weight="semibold"
							/>
						)}
					</GlassSurface>
				</Animated.View>
			</Pressable>
			{caption ? (
				<Text
					allowFontScaling={false}
					numberOfLines={1}
					style={[
						styles.caption,
						active ? styles.captionActive : null,
						isDisabled ? styles.captionDisabled : null,
					]}
				>
					{caption}
				</Text>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	wrapper: {
		alignItems: "center",
		gap: 8,
	},
	circle: {
		alignItems: "center",
		justifyContent: "center",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		backgroundColor: colors.gray2,
		overflow: "hidden",
		...squircle,
	},
	circleActive: {
		borderColor: colors.green9,
		backgroundColor: "#e9f7ee",
	},
	circleDisabled: {
		backgroundColor: colors.gray3,
		borderColor: colors.gray4,
	},
	glass: {
		flex: 1,
		alignSelf: "stretch",
		alignItems: "center",
		justifyContent: "center",
	},
	glassFallback: {
		backgroundColor: "transparent",
	},
	caption: {
		fontFamily: fonts.medium,
		fontSize: 12,
		lineHeight: 15,
		color: colors.gray11,
	},
	captionActive: {
		color: colors.green9,
	},
	captionDisabled: {
		color: colors.gray9,
	},
});

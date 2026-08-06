import { type SFSymbol, SymbolView } from "expo-symbols";
import type { ReactNode } from "react";
import {
	type AccessibilityValue,
	ActivityIndicator,
	type GestureResponderEvent,
	Pressable,
	StyleSheet,
	Text,
	View,
	type ViewStyle,
} from "react-native";
import { colors, fonts, radius, squircle } from "@/theme";

type ActionButtonProps = {
	label: string;
	onPress: (event?: GestureResponderEvent) => void;
	accessibilityLabel?: string;
	accessibilityHint?: string;
	accessibilityValue?: AccessibilityValue;
	symbol?: SFSymbol;
	leading?: ReactNode;
	variant?:
		| "primary"
		| "blue"
		| "secondary"
		| "gray"
		| "dark"
		| "danger"
		| "ghost";
	size?: "sm" | "md" | "lg";
	disabled?: boolean;
	loading?: boolean;
	style?: ViewStyle;
	children?: ReactNode;
};

const labelBySize = {
	sm: "labelSm",
	md: "labelMd",
	lg: "labelLg",
} as const;

const iconColor = (
	variant: NonNullable<ActionButtonProps["variant"]>,
	isDisabled: boolean,
) => {
	if (isDisabled) {
		if (variant === "primary") return colors.gray9;
		if (variant === "blue" || variant === "dark" || variant === "danger") {
			return colors.gray10;
		}
		if (variant === "gray") return colors.gray11;
	}

	return variant === "primary" ||
		variant === "blue" ||
		variant === "dark" ||
		variant === "danger"
		? colors.white
		: colors.gray12;
};

const usesInsetHighlight = (
	variant: NonNullable<ActionButtonProps["variant"]>,
) =>
	variant === "primary" ||
	variant === "blue" ||
	variant === "gray" ||
	variant === "dark";

const buttonHitSlop = { bottom: 4, left: 4, right: 4, top: 4 };
const androidRipple = { color: colors.blackAlpha5 };

export function ActionButton({
	label,
	onPress,
	accessibilityLabel,
	accessibilityHint,
	accessibilityValue,
	symbol,
	leading,
	variant = "primary",
	size = "md",
	disabled = false,
	loading = false,
	style,
	children,
}: ActionButtonProps) {
	const isDisabled = disabled || loading;
	const showInsetHighlight = usesInsetHighlight(variant);

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel ?? label}
			accessibilityHint={accessibilityHint}
			accessibilityState={{ busy: loading, disabled: isDisabled }}
			accessibilityValue={accessibilityValue}
			android_ripple={androidRipple}
			hitSlop={buttonHitSlop}
			onPress={onPress}
			disabled={isDisabled}
			style={({ pressed }) => [
				styles.base,
				styles[size],
				styles[variant],
				isDisabled && styles[`${variant}Disabled`],
				pressed && !isDisabled && pressedStyles[variant],
				style,
			]}
		>
			{showInsetHighlight ? (
				<View pointerEvents="none" style={styles.insetHighlight} />
			) : null}
			{loading ? (
				<ActivityIndicator color={iconColor(variant, isDisabled)} />
			) : leading ? (
				leading
			) : symbol ? (
				<SymbolView
					name={symbol}
					size={18}
					tintColor={iconColor(variant, isDisabled)}
					type="monochrome"
					weight="semibold"
				/>
			) : null}
			<Text
				numberOfLines={1}
				adjustsFontSizeToFit
				style={[
					styles.label,
					styles[labelBySize[size]],
					variant === "primary" ||
					variant === "blue" ||
					variant === "dark" ||
					variant === "danger"
						? styles.primaryLabel
						: styles.defaultLabel,
					isDisabled && styles[`${variant}DisabledLabel`],
				]}
			>
				{children ?? label}
			</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	base: {
		alignItems: "center",
		justifyContent: "center",
		flexDirection: "row",
		gap: 4,
		position: "relative",
		borderWidth: StyleSheet.hairlineWidth,
		overflow: "hidden",
		...squircle,
	},
	sm: {
		height: 40,
		borderRadius: radius.full,
		paddingHorizontal: 20,
	},
	md: {
		height: 44,
		borderRadius: radius.full,
		paddingHorizontal: 20,
	},
	lg: {
		height: 48,
		borderRadius: radius.full,
		paddingHorizontal: 20,
	},
	primary: {
		backgroundColor: colors.gray12,
		borderColor: colors.gray12,
	},
	primaryPressed: {
		backgroundColor: colors.gray11,
		borderColor: colors.gray11,
	},
	blue: {
		backgroundColor: colors.buttonBlue,
		borderColor: colors.buttonBlueBorder,
	},
	bluePressed: {
		backgroundColor: colors.buttonBlueHover,
		borderColor: colors.buttonBlueBorder,
	},
	dark: {
		backgroundColor: colors.gray12,
		borderColor: colors.gray12,
	},
	darkPressed: {
		backgroundColor: colors.gray11,
		borderColor: colors.gray11,
	},
	secondary: {
		backgroundColor: colors.gray3,
		borderColor: colors.gray5,
	},
	secondaryPressed: {
		backgroundColor: colors.gray5,
		borderColor: colors.gray6,
	},
	gray: {
		backgroundColor: colors.gray5,
		borderColor: colors.gray8,
	},
	grayPressed: {
		backgroundColor: colors.gray7,
		borderColor: colors.gray8,
	},
	danger: {
		backgroundColor: colors.red9,
		borderColor: colors.red9,
	},
	dangerPressed: {
		backgroundColor: colors.red10,
		borderColor: colors.red10,
	},
	ghost: {
		backgroundColor: "transparent",
		borderColor: "transparent",
	},
	ghostPressed: {
		backgroundColor: colors.blackAlpha5,
		borderColor: "transparent",
	},
	primaryDisabled: {
		backgroundColor: colors.gray6,
		borderColor: colors.gray6,
	},
	blueDisabled: {
		backgroundColor: colors.gray7,
		borderColor: colors.gray8,
	},
	darkDisabled: {
		backgroundColor: colors.gray7,
		borderColor: colors.gray8,
	},
	secondaryDisabled: {
		backgroundColor: colors.gray8,
		borderColor: colors.gray8,
	},
	grayDisabled: {
		backgroundColor: colors.gray8,
		borderColor: colors.gray7,
	},
	dangerDisabled: {
		backgroundColor: colors.gray7,
		borderColor: colors.gray8,
	},
	ghostDisabled: {
		backgroundColor: "transparent",
		borderColor: "transparent",
	},
	label: {
		fontFamily: fonts.medium,
	},
	labelSm: {
		fontSize: 14,
		lineHeight: 18,
	},
	labelMd: {
		fontSize: 14,
		lineHeight: 20,
	},
	labelLg: {
		fontSize: 16,
		lineHeight: 22,
	},
	primaryLabel: {
		color: colors.white,
	},
	defaultLabel: {
		color: colors.gray12,
	},
	primaryDisabledLabel: {
		color: colors.gray9,
	},
	blueDisabledLabel: {
		color: colors.gray10,
	},
	darkDisabledLabel: {
		color: colors.gray10,
	},
	secondaryDisabledLabel: {
		color: colors.gray11,
	},
	grayDisabledLabel: {
		color: colors.gray11,
	},
	dangerDisabledLabel: {
		color: colors.gray10,
	},
	ghostDisabledLabel: {
		color: colors.gray9,
	},
	insetHighlight: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		height: 1.5,
		backgroundColor: "rgba(255, 255, 255, 0.4)",
	},
});

const pressedStyles = {
	primary: styles.primaryPressed,
	blue: styles.bluePressed,
	secondary: styles.secondaryPressed,
	gray: styles.grayPressed,
	dark: styles.darkPressed,
	danger: styles.dangerPressed,
	ghost: styles.ghostPressed,
} as const;

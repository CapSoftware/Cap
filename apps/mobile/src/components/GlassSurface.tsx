import {
	GlassView,
	isGlassEffectAPIAvailable,
	isLiquidGlassAvailable,
} from "expo-glass-effect";
import type { ReactNode } from "react";
import {
	Platform,
	type StyleProp,
	StyleSheet,
	View,
	type ViewStyle,
} from "react-native";
import { colors } from "@/theme";

type GlassSurfaceProps = {
	children?: ReactNode;
	style?: StyleProp<ViewStyle>;
	fallbackStyle?: StyleProp<ViewStyle>;
	glassEffectStyle?: "clear" | "regular" | "none";
	tintColor?: string;
	isInteractive?: boolean;
};

const getGlassAvailable = () => {
	if (Platform.OS !== "ios") return false;
	try {
		return isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
	} catch {
		return false;
	}
};

const glassAvailable = getGlassAvailable();

export function GlassSurface({
	children,
	style,
	fallbackStyle,
	glassEffectStyle = "regular",
	tintColor = colors.glass,
	isInteractive = false,
}: GlassSurfaceProps) {
	if (glassAvailable) {
		return (
			<GlassView
				colorScheme="light"
				glassEffectStyle={glassEffectStyle}
				isInteractive={isInteractive}
				style={[styles.surface, style]}
				tintColor={tintColor}
			>
				{children}
			</GlassView>
		);
	}

	return (
		<View style={[styles.surface, styles.fallback, fallbackStyle, style]}>
			{children}
		</View>
	);
}

const styles = StyleSheet.create({
	surface: {
		overflow: "hidden",
	},
	fallback: {
		backgroundColor: colors.glass,
	},
});

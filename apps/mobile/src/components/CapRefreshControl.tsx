import { Platform, RefreshControl, StyleSheet } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { colors } from "@/theme";
import { CapLoadingIndicator } from "./CapLoadingIndicator";

type CapRefreshControlProps = {
	refreshing: boolean;
	onRefresh: () => void;
};

// iOS hides the native spinner so CapRefreshOverlay can show the Cap logo in
// the pull gap; Android's SwipeRefreshLayout draws its own overlay circle, so
// it keeps the tinted native control.
export function CapRefreshControl({
	refreshing,
	onRefresh,
}: CapRefreshControlProps) {
	return (
		<RefreshControl
			colors={[colors.blue11]}
			onRefresh={onRefresh}
			progressBackgroundColor={colors.gray1}
			refreshing={refreshing}
			tintColor={Platform.OS === "ios" ? "transparent" : colors.blue11}
		/>
	);
}

type CapRefreshOverlayProps = {
	refreshing: boolean;
};

export function CapRefreshOverlay({ refreshing }: CapRefreshOverlayProps) {
	if (Platform.OS !== "ios" || !refreshing) return null;
	return (
		<Animated.View
			exiting={FadeOut.duration(120)}
			style={styles.overlay}
			testID="cap-refresh-overlay"
		>
			<CapLoadingIndicator size={32} />
		</Animated.View>
	);
}

const styles = StyleSheet.create({
	overlay: {
		alignItems: "center",
		height: 60,
		justifyContent: "center",
		left: 0,
		pointerEvents: "none",
		position: "absolute",
		right: 0,
		top: 0,
	},
});

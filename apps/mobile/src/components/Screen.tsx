import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { type Edge, SafeAreaView } from "react-native-safe-area-context";
import { colors, fonts } from "@/theme";
import { CapLoadingIndicator } from "./CapLoadingIndicator";
import { CapRefreshControl, CapRefreshOverlay } from "./CapRefreshControl";

type ScreenProps = {
	children?: ReactNode;
	title?: string;
	subtitle?: string | null;
	scroll?: boolean;
	refreshing?: boolean;
	onRefresh?: () => void;
	loading?: boolean;
	footer?: ReactNode;
	safeEdges?: Edge[];
	automaticallyAdjustKeyboardInsets?: boolean;
	contentInsetBottom?: number;
	headerLeft?: ReactNode;
};

const defaultSafeEdges: Edge[] = ["top", "left", "right"];

export function Screen({
	children,
	title,
	subtitle,
	scroll = false,
	refreshing = false,
	onRefresh,
	loading = false,
	footer,
	safeEdges = defaultSafeEdges,
	automaticallyAdjustKeyboardInsets = false,
	contentInsetBottom,
	headerLeft,
}: ScreenProps) {
	const content = (
		<>
			{title ? (
				<View style={[styles.header, subtitle && styles.headerWithSubtitle]}>
					{headerLeft ? (
						<View style={styles.headerLeft}>{headerLeft}</View>
					) : null}
					<Text style={styles.title}>{title}</Text>
					{subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
				</View>
			) : null}
			{loading ? (
				<View style={styles.loading}>
					<CapLoadingIndicator />
				</View>
			) : (
				children
			)}
			{footer}
		</>
	);

	return (
		<SafeAreaView style={styles.safeArea} edges={safeEdges}>
			{scroll ? (
				<>
					<ScrollView
						automaticallyAdjustKeyboardInsets={
							automaticallyAdjustKeyboardInsets
						}
						contentInsetAdjustmentBehavior="automatic"
						contentContainerStyle={[
							styles.scrollContent,
							contentInsetBottom != null
								? { paddingBottom: contentInsetBottom }
								: null,
						]}
						keyboardDismissMode="interactive"
						keyboardShouldPersistTaps="handled"
						refreshControl={
							onRefresh ? (
								<CapRefreshControl
									refreshing={refreshing}
									onRefresh={onRefresh}
								/>
							) : undefined
						}
					>
						{content}
					</ScrollView>
					{onRefresh ? <CapRefreshOverlay refreshing={refreshing} /> : null}
				</>
			) : (
				<View
					style={[
						styles.content,
						contentInsetBottom != null
							? { paddingBottom: contentInsetBottom }
							: null,
					]}
				>
					{content}
				</View>
			)}
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	safeArea: {
		flex: 1,
		backgroundColor: colors.appBackground,
	},
	content: {
		flex: 1,
		paddingHorizontal: 20,
		paddingBottom: 18,
	},
	scrollContent: {
		flexGrow: 1,
		paddingHorizontal: 20,
		paddingBottom: 28,
	},
	header: {
		paddingTop: 8,
		paddingBottom: 16,
		gap: 4,
	},
	headerWithSubtitle: {
		paddingBottom: 32,
	},
	headerLeft: {
		marginBottom: 4,
	},
	title: {
		fontFamily: fonts.medium,
		fontSize: 24,
		lineHeight: 30,
		color: colors.gray12,
	},
	subtitle: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray10,
	},
	loading: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		paddingVertical: 48,
	},
});

import * as Clipboard from "expo-clipboard";
import { router, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MobileApiError } from "@/api/mobile";
import { useAuth } from "@/auth/AuthContext";
import { SignInPanel } from "@/auth/SignInPanel";
import { ActionButton } from "@/components/ActionButton";
import { GlassSurface } from "@/components/GlassSurface";
import { Screen } from "@/components/Screen";
import { colors, fonts, radius, squircle } from "@/theme";

export const isLoomShareUrl = (value: string) => {
	try {
		const url = new URL(value.trim());
		const hostnameValid =
			url.hostname === "loom.com" || url.hostname.endsWith(".loom.com");
		const videoId = url.pathname.split("/").filter(Boolean).at(-1);
		return (
			url.protocol === "https:" &&
			hostnameValid &&
			Boolean(videoId && videoId.length >= 10)
		);
	} catch {
		return false;
	}
};

const importErrorMessage = (error: unknown) => {
	if (error instanceof MobileApiError) {
		if (error.status === 403) {
			return "Loom import is available on Cap Pro. Your current plan does not include this feature.";
		}
		if (error.status === 400) {
			return "That Loom video could not be imported. It may be private, already imported, or temporarily unavailable.";
		}
	}
	return "The import could not start. Check your connection and try again.";
};

export default function LoomImportScreen() {
	const auth = useAuth();
	const [loomUrl, setLoomUrl] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const valid = isLoomShareUrl(loomUrl);

	const paste = async () => {
		try {
			const value = await Clipboard.getStringAsync();
			setLoomUrl(value.trim());
			setError(null);
		} catch {
			setError(
				"The clipboard could not be read. Paste the Loom link manually.",
			);
		}
	};

	const submit = async () => {
		if (auth.status !== "signedIn" || submitting) return;
		if (!valid) {
			setError(
				"Paste a valid Loom share link that starts with https://loom.com.",
			);
			return;
		}

		setSubmitting(true);
		setError(null);
		try {
			const result = await auth.client.importLoom(loomUrl.trim());
			void auth.refresh().catch(() => undefined);
			router.replace({ pathname: "/caps/[id]", params: { id: result.id } });
		} catch (cause) {
			setError(importErrorMessage(cause));
		} finally {
			setSubmitting(false);
		}
	};

	if (auth.status === "signedOut") {
		return (
			<Screen scroll safeEdges={["left", "right", "bottom"]}>
				<SignInPanel title="Sign in to import from Loom" />
			</Screen>
		);
	}

	return (
		<>
			<Stack.Screen
				options={{
					headerShown: true,
					title: "Import from Loom",
					headerBackTitle: "Back",
					headerShadowVisible: false,
					headerStyle: { backgroundColor: colors.appBackground },
				}}
			/>
			<Screen
				automaticallyAdjustKeyboardInsets
				scroll
				safeEdges={["left", "right", "bottom"]}
			>
				<View style={styles.heading}>
					<View style={styles.icon}>
						<SymbolView name="arrow.down.doc" size={28} tintColor="#625DF5" />
					</View>
					<Text style={styles.title}>Bring a Loom video into Cap</Text>
					<Text style={styles.subtitle}>
						Paste a public Loom share link. The transfer continues on Cap’s
						servers, so the video never downloads to your phone.
					</Text>
				</View>
				<GlassSurface
					fallbackStyle={styles.cardFallback}
					style={styles.card}
					tintColor={colors.gray1}
				>
					<Text style={styles.label}>Loom share link</Text>
					<View style={styles.inputRow}>
						<TextInput
							accessibilityLabel="Loom share link"
							autoCapitalize="none"
							autoCorrect={false}
							editable={!submitting}
							keyboardType="url"
							onChangeText={(value) => {
								setLoomUrl(value);
								setError(null);
							}}
							onSubmitEditing={() => void submit()}
							placeholder="https://www.loom.com/share/..."
							placeholderTextColor={colors.gray8}
							returnKeyType="go"
							style={styles.input}
							value={loomUrl}
						/>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Paste Loom link"
							disabled={submitting}
							onPress={() => void paste()}
							style={({ pressed }) => [
								styles.pasteButton,
								pressed && styles.pasteButtonPressed,
							]}
						>
							<Text style={styles.pasteLabel}>Paste</Text>
						</Pressable>
					</View>
					<View style={styles.detailRow}>
						<SymbolView
							name="checkmark.shield"
							size={17}
							tintColor={colors.green9}
						/>
						<Text style={styles.detailText}>
							Your original Loom video is left unchanged.
						</Text>
					</View>
					<View style={styles.detailRow}>
						<SymbolView name="bolt" size={17} tintColor={colors.blue9} />
						<Text style={styles.detailText}>
							Processing begins in the background as soon as the import starts.
						</Text>
					</View>
				</GlassSurface>
				{error ? (
					<View accessibilityLiveRegion="polite" style={styles.errorCard}>
						<SymbolView
							name="exclamationmark.triangle"
							size={18}
							tintColor={colors.red9}
						/>
						<Text style={styles.errorText}>{error}</Text>
					</View>
				) : null}
				<ActionButton
					disabled={!valid}
					label={submitting ? "Starting import" : "Import video"}
					loading={submitting}
					onPress={() => void submit()}
					style={styles.importButton}
					variant="blue"
				/>
				<Text style={styles.proNote}>Loom import requires Cap Pro.</Text>
			</Screen>
		</>
	);
}

const styles = StyleSheet.create({
	heading: {
		alignItems: "center",
		paddingTop: 22,
		paddingBottom: 24,
		paddingHorizontal: 12,
	},
	icon: {
		width: 58,
		height: 58,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: radius.lg,
		backgroundColor: "#EFEEFF",
		marginBottom: 16,
		...squircle,
	},
	title: {
		fontFamily: fonts.medium,
		fontSize: 24,
		lineHeight: 30,
		color: colors.gray12,
		textAlign: "center",
	},
	subtitle: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray10,
		textAlign: "center",
		marginTop: 8,
	},
	card: {
		borderRadius: radius.lg,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		padding: 16,
		gap: 14,
		...squircle,
	},
	cardFallback: {
		backgroundColor: colors.gray1,
	},
	label: {
		fontFamily: fonts.medium,
		fontSize: 14,
		color: colors.gray12,
	},
	inputRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	input: {
		flex: 1,
		height: 48,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray5,
		backgroundColor: colors.white,
		paddingHorizontal: 13,
		fontFamily: fonts.regular,
		fontSize: 16,
		color: colors.gray12,
		...squircle,
	},
	pasteButton: {
		height: 48,
		justifyContent: "center",
		paddingHorizontal: 14,
		borderRadius: radius.md,
		backgroundColor: colors.gray3,
		...squircle,
	},
	pasteButtonPressed: {
		backgroundColor: colors.gray5,
	},
	pasteLabel: {
		fontFamily: fonts.medium,
		fontSize: 14,
		color: colors.gray12,
	},
	detailRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 9,
	},
	detailText: {
		flex: 1,
		fontFamily: fonts.regular,
		fontSize: 13,
		lineHeight: 18,
		color: colors.gray10,
	},
	errorCard: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 10,
		padding: 14,
		borderRadius: radius.md,
		backgroundColor: colors.red3,
		marginTop: 14,
		...squircle,
	},
	errorText: {
		flex: 1,
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.red11,
	},
	importButton: {
		marginTop: 18,
	},
	proNote: {
		fontFamily: fonts.regular,
		fontSize: 12,
		color: colors.gray9,
		textAlign: "center",
		marginTop: 10,
	},
});

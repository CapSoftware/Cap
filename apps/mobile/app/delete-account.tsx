import { router, Stack } from "expo-router";
import { useState } from "react";
import {
	ActionSheetIOS,
	Alert,
	Platform,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { MobileApiError } from "@/api/mobile";
import { useAuth } from "@/auth/AuthContext";
import { SignInPanel } from "@/auth/SignInPanel";
import { ActionButton } from "@/components/ActionButton";
import { GlassSurface } from "@/components/GlassSurface";
import { Screen } from "@/components/Screen";
import { colors, fonts, radius, squircle } from "@/theme";

const deletionErrorMessage = (error: unknown) => {
	if (error instanceof MobileApiError && error.status === 401) {
		return "Your session expired. Sign in again before requesting deletion.";
	}
	return "Your deletion request could not be submitted. Check your connection and try again.";
};

export default function DeleteAccountScreen() {
	const auth = useAuth();
	const [confirmation, setConfirmation] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const confirmed = confirmation.trim() === "DELETE";

	const submit = async () => {
		if (!confirmed || submitting) return;
		setSubmitting(true);
		setError(null);
		try {
			await auth.client.requestAccountDeletion();
			await auth.signOut();
			router.replace("/(tabs)/account");
			Alert.alert(
				"Deletion request received",
				"We will permanently delete your account and associated data within 30 days and email you when it is complete.",
			);
		} catch (cause) {
			setError(deletionErrorMessage(cause));
			setSubmitting(false);
		}
	};

	const confirmDeletion = () => {
		if (!confirmed || submitting) return;

		if (Platform.OS === "ios") {
			ActionSheetIOS.showActionSheetWithOptions(
				{
					cancelButtonIndex: 1,
					destructiveButtonIndex: 0,
					message:
						"This starts permanent deletion of your Cap account and associated data. This cannot be undone.",
					options: ["Request permanent deletion", "Cancel"],
					title: "Delete your Cap account?",
					tintColor: colors.blue11,
					userInterfaceStyle: "light",
				},
				(index) => {
					if (index === 0) void submit();
				},
			);
			return;
		}

		Alert.alert(
			"Delete your Cap account?",
			"This starts permanent deletion of your Cap account and associated data. This cannot be undone.",
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Request permanent deletion",
					style: "destructive",
					onPress: () => void submit(),
				},
			],
		);
	};

	if (auth.status === "signedOut") {
		return (
			<Screen scroll safeEdges={["left", "right", "bottom"]}>
				<SignInPanel title="Sign in to manage your account" />
			</Screen>
		);
	}

	return (
		<>
			<Stack.Screen
				options={{
					headerShown: true,
					title: "Delete Account",
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
					<Text style={styles.title}>Permanently delete your account</Text>
					<Text style={styles.subtitle}>
						Your request begins immediately and cannot be undone after
						processing.
					</Text>
				</View>
				<GlassSurface
					fallbackStyle={styles.cardFallback}
					style={styles.card}
					tintColor={colors.gray1}
				>
					<Text style={styles.cardTitle}>What will be deleted</Text>
					<View style={styles.list}>
						<Text style={styles.listItem}>
							• Your Cap account, profile, and personal data
						</Text>
						<Text style={styles.listItem}>
							• Caps, videos, comments, and other content associated with your
							account
						</Text>
						<Text style={styles.listItem}>
							• Organizations you solely own and your access to shared
							organizations
						</Text>
					</View>
					<Text style={styles.detail}>
						You will be signed out immediately and cannot sign in while we
						process deletion. Within 30 days, we cancel any direct Cap
						subscription and email you when deletion is complete.
					</Text>
				</GlassSurface>
				<View style={styles.field}>
					<Text style={styles.label}>
						Type <Text style={styles.confirmationWord}>DELETE</Text> to confirm
					</Text>
					<TextInput
						accessibilityLabel="Deletion confirmation"
						autoCapitalize="characters"
						autoCorrect={false}
						editable={!submitting}
						onChangeText={setConfirmation}
						placeholder="DELETE"
						placeholderTextColor={colors.gray9}
						returnKeyType="done"
						style={styles.input}
						value={confirmation}
					/>
				</View>
				{error ? (
					<Text accessibilityLiveRegion="polite" style={styles.error}>
						{error}
					</Text>
				) : null}
				<ActionButton
					accessibilityHint="Starts permanent account deletion"
					disabled={!confirmed}
					label="Request account deletion"
					loading={submitting}
					onPress={confirmDeletion}
					size="lg"
					symbol="trash"
					variant="danger"
				/>
			</Screen>
		</>
	);
}

const styles = StyleSheet.create({
	heading: {
		gap: 6,
		marginBottom: 20,
	},
	title: {
		color: colors.gray12,
		fontFamily: fonts.bold,
		fontSize: 24,
		lineHeight: 30,
	},
	subtitle: {
		color: colors.gray11,
		fontFamily: fonts.regular,
		fontSize: 15,
		lineHeight: 21,
	},
	card: {
		borderColor: colors.red6,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		gap: 14,
		padding: 16,
		...squircle,
	},
	cardFallback: {
		backgroundColor: colors.red2,
	},
	cardTitle: {
		color: colors.red12,
		fontFamily: fonts.bold,
		fontSize: 17,
		lineHeight: 22,
	},
	list: {
		gap: 8,
	},
	listItem: {
		color: colors.gray12,
		fontFamily: fonts.regular,
		fontSize: 15,
		lineHeight: 21,
	},
	detail: {
		color: colors.gray11,
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
	},
	field: {
		gap: 8,
		marginTop: 22,
		marginBottom: 16,
	},
	label: {
		color: colors.gray12,
		fontFamily: fonts.medium,
		fontSize: 14,
		lineHeight: 19,
	},
	confirmationWord: {
		color: colors.red11,
		fontFamily: fonts.bold,
	},
	input: {
		backgroundColor: colors.white,
		borderColor: colors.gray7,
		borderRadius: radius.sm,
		borderWidth: StyleSheet.hairlineWidth,
		color: colors.gray12,
		fontFamily: fonts.medium,
		fontSize: 16,
		minHeight: 48,
		paddingHorizontal: 14,
		...squircle,
	},
	error: {
		color: colors.red11,
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		marginBottom: 12,
	},
});

import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import {
	ActionSheetIOS,
	ActivityIndicator,
	Alert,
	Linking,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { MobileApiError, type MobileUser } from "@/api/mobile";
import { useAuth } from "@/auth/AuthContext";
import { SignInPanel } from "@/auth/SignInPanel";
import { ActionButton } from "@/components/ActionButton";
import { GlassSurface } from "@/components/GlassSurface";
import { Screen } from "@/components/Screen";
import { colors, fonts, radius, squircle } from "@/theme";

const maxImageBytes = 1024 * 1024;

const getImageContentType = (data: string) => {
	if (data.startsWith("iVBORw0KGgo")) return "image/png" as const;
	if (data.startsWith("/9j/")) return "image/jpeg" as const;
	return null;
};

const profileErrorMessage = (error: unknown) => {
	if (error instanceof MobileApiError && error.status === 400) {
		return "Check your profile details and try again.";
	}
	return "Your profile could not be updated. Check your connection and try again.";
};

const openPhotoSettings = () => {
	if (Platform.OS === "ios") {
		ActionSheetIOS.showActionSheetWithOptions(
			{
				cancelButtonIndex: 1,
				message: "Allow Cap to choose a profile image from Settings.",
				options: ["Open Settings", "Cancel"],
				title: "Photos access needed",
				tintColor: colors.blue11,
				userInterfaceStyle: "light",
			},
			(index) => {
				if (index === 0) void Linking.openSettings();
			},
		);
		return;
	}

	Alert.alert(
		"Photos access needed",
		"Allow Cap to choose a profile image from Settings.",
		[
			{ text: "Cancel", style: "cancel" },
			{ text: "Open Settings", onPress: () => void Linking.openSettings() },
		],
	);
};

const fullName = (profile: MobileUser) =>
	[profile.name, profile.lastName].filter(Boolean).join(" ").trim();

export default function ProfileSettingsScreen() {
	const auth = useAuth();
	const initialProfile = auth.bootstrap?.user ?? null;
	const [profile, setProfile] = useState<MobileUser | null>(null);
	const [firstName, setFirstName] = useState("");
	const [lastName, setLastName] = useState("");
	const [saving, setSaving] = useState(false);
	const [imageBusy, setImageBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);

	useEffect(() => {
		if (!initialProfile || profile) return;
		setProfile(initialProfile);
		setFirstName(initialProfile.name ?? "");
		setLastName(initialProfile.lastName ?? "");
	}, [initialProfile, profile]);

	const dirty =
		profile !== null &&
		(firstName.trim() !== (profile.name ?? "") ||
			lastName.trim() !== (profile.lastName ?? ""));
	const busy = saving || imageBusy;

	const applyProfile = async (
		nextProfile: MobileUser,
		syncNameFields = true,
	) => {
		setProfile(nextProfile);
		if (syncNameFields) {
			setFirstName(nextProfile.name ?? "");
			setLastName(nextProfile.lastName ?? "");
		}
		await auth.refresh().catch(() => undefined);
	};

	const save = async () => {
		if (!profile || busy || !firstName.trim()) return;
		setSaving(true);
		setError(null);
		setSuccess(null);
		try {
			const response = await auth.client.updateProfile({
				name: firstName.trim(),
				lastName: lastName.trim() || null,
			});
			await applyProfile(response);
			setSuccess("Profile updated.");
		} catch (cause) {
			setError(profileErrorMessage(cause));
		} finally {
			setSaving(false);
		}
	};

	const chooseImage = async () => {
		if (!profile || busy) return;
		let result: ImagePicker.ImagePickerResult;
		try {
			const permission =
				await ImagePicker.requestMediaLibraryPermissionsAsync();
			if (!permission.granted) {
				openPhotoSettings();
				return;
			}
			result = await ImagePicker.launchImageLibraryAsync({
				allowsEditing: true,
				aspect: [1, 1],
				base64: true,
				mediaTypes: ["images"],
				quality: 0.8,
			});
		} catch {
			setError("Photos could not be opened. Check access and try again.");
			return;
		}

		if (result.canceled) return;
		const asset = result.assets[0];
		if (!asset?.base64) {
			setError("The selected image could not be read. Choose another image.");
			return;
		}
		const contentType = getImageContentType(asset.base64);
		if (!contentType) {
			setError("Choose a PNG or JPEG image.");
			return;
		}
		const expectedExtensions =
			contentType === "image/png" ? ["png"] : ["jpg", "jpeg"];
		const sourceFileName = asset.fileName?.split(/[\\/]/).at(-1);
		const sourceExtension = sourceFileName?.split(".").at(-1)?.toLowerCase();
		const fileName =
			sourceFileName &&
			sourceExtension &&
			expectedExtensions.includes(sourceExtension)
				? sourceFileName
				: `profile-${Date.now()}.${expectedExtensions[0]}`;
		if (
			(asset.fileSize && asset.fileSize > maxImageBytes) ||
			asset.base64.length > Math.ceil((maxImageBytes * 4) / 3) + 4
		) {
			setError("Choose a PNG or JPEG that is 1 MB or smaller.");
			return;
		}

		setImageBusy(true);
		setError(null);
		setSuccess(null);
		try {
			const response = await auth.client.updateProfileImage({
				data: asset.base64,
				contentType,
				fileName,
			});
			await applyProfile(response, false);
			setSuccess("Profile image updated.");
		} catch (cause) {
			setError(profileErrorMessage(cause));
		} finally {
			setImageBusy(false);
		}
	};

	const removeImage = async () => {
		if (!profile?.imageUrl || busy) return;
		setImageBusy(true);
		setError(null);
		setSuccess(null);
		try {
			const response = await auth.client.removeProfileImage();
			await applyProfile(response, false);
			setSuccess("Profile image removed.");
		} catch (cause) {
			setError(profileErrorMessage(cause));
		} finally {
			setImageBusy(false);
		}
	};

	const showImageActions = () => {
		if (!profile || busy) return;
		const options = profile.imageUrl
			? ["Choose Photo", "Remove Photo", "Cancel"]
			: ["Choose Photo", "Cancel"];
		if (Platform.OS === "ios") {
			ActionSheetIOS.showActionSheetWithOptions(
				{
					cancelButtonIndex: options.length - 1,
					destructiveButtonIndex: profile.imageUrl ? 1 : undefined,
					options,
					title: "Profile image",
					tintColor: colors.blue11,
					userInterfaceStyle: "light",
				},
				(index) => {
					if (index === 0) void chooseImage();
					if (profile.imageUrl && index === 1) void removeImage();
				},
			);
			return;
		}

		Alert.alert("Profile image", undefined, [
			{ text: "Choose Photo", onPress: () => void chooseImage() },
			...(profile.imageUrl
				? [
						{
							text: "Remove Photo",
							style: "destructive" as const,
							onPress: () => void removeImage(),
						},
					]
				: []),
			{ text: "Cancel", style: "cancel" },
		]);
	};

	if (auth.status === "signedOut") {
		return (
			<Screen scroll safeEdges={["left", "right", "bottom"]}>
				<SignInPanel title="Sign in to edit your profile" />
			</Screen>
		);
	}

	return (
		<>
			<Stack.Screen
				options={{
					headerShown: true,
					title: "Profile",
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
					<Text style={styles.title}>Your profile</Text>
					<Text style={styles.subtitle}>
						Your name and image appear on shared Caps and comments.
					</Text>
				</View>
				{!profile ? (
					<View style={styles.state}>
						<ActivityIndicator color={colors.blue9} />
						<Text style={styles.stateText}>Loading profile…</Text>
					</View>
				) : (
					<>
						<GlassSurface
							fallbackStyle={styles.cardFallback}
							style={styles.card}
							tintColor={colors.gray1}
						>
							<Pressable
								accessibilityHint="Opens profile image actions"
								accessibilityLabel="Profile image"
								accessibilityRole="button"
								accessibilityState={{ busy: imageBusy, disabled: busy }}
								accessibilityValue={{
									text: profile.imageUrl
										? "Profile image set"
										: "No profile image",
								}}
								disabled={busy}
								onPress={showImageActions}
								style={({ pressed }) => [
									styles.imageRow,
									pressed && !busy && styles.imageRowPressed,
								]}
							>
								<View style={styles.imagePreview}>
									{imageBusy ? (
										<ActivityIndicator color={colors.blue9} />
									) : profile.imageUrl ? (
										<Image
											cachePolicy="memory-disk"
											contentFit="cover"
											source={{ uri: profile.imageUrl }}
											style={styles.image}
										/>
									) : (
										<Text style={styles.initial}>
											{(fullName(profile) || profile.email)
												.slice(0, 1)
												.toUpperCase()}
										</Text>
									)}
								</View>
								<View style={styles.imageCopy}>
									<Text style={styles.rowTitle}>Profile image</Text>
									<Text style={styles.rowSubtitle}>
										PNG or JPEG, up to 1 MB
									</Text>
								</View>
								<SymbolView
									name="chevron.right"
									size={13}
									tintColor={colors.gray9}
								/>
							</Pressable>
							<View style={styles.field}>
								<Text style={styles.label}>First name</Text>
								<TextInput
									accessibilityLabel="First name"
									autoCapitalize="words"
									editable={!busy}
									maxLength={255}
									onChangeText={(value) => {
										setFirstName(value);
										setSuccess(null);
									}}
									placeholder="First name"
									placeholderTextColor={colors.gray8}
									style={styles.input}
									value={firstName}
								/>
							</View>
							<View style={styles.field}>
								<Text style={styles.label}>Last name</Text>
								<TextInput
									accessibilityLabel="Last name"
									autoCapitalize="words"
									editable={!busy}
									maxLength={255}
									onChangeText={(value) => {
										setLastName(value);
										setSuccess(null);
									}}
									placeholder="Last name (optional)"
									placeholderTextColor={colors.gray8}
									style={styles.input}
									value={lastName}
								/>
							</View>
						</GlassSurface>
						{error ? (
							<Text accessibilityRole="alert" style={styles.error}>
								{error}
							</Text>
						) : null}
						{success ? (
							<Text accessibilityLiveRegion="polite" style={styles.success}>
								{success}
							</Text>
						) : null}
						<ActionButton
							disabled={!dirty || !firstName.trim() || imageBusy}
							label="Save changes"
							loading={saving}
							onPress={() => void save()}
							style={styles.saveButton}
							variant="blue"
						/>
					</>
				)}
			</Screen>
		</>
	);
}

const styles = StyleSheet.create({
	heading: {
		paddingTop: 10,
		paddingBottom: 20,
		gap: 4,
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
	state: {
		minHeight: 320,
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
	},
	stateText: {
		fontFamily: fonts.regular,
		fontSize: 14,
		color: colors.gray10,
	},
	card: {
		borderRadius: radius.lg,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		padding: 16,
		gap: 20,
		...squircle,
	},
	cardFallback: {
		backgroundColor: colors.gray1,
	},
	imageRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		margin: -4,
		padding: 4,
		borderRadius: radius.md,
		...squircle,
	},
	imageRowPressed: {
		backgroundColor: colors.gray3,
	},
	imagePreview: {
		width: 72,
		height: 72,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.blue3,
		overflow: "hidden",
		...squircle,
	},
	image: {
		width: "100%",
		height: "100%",
	},
	initial: {
		fontFamily: fonts.medium,
		fontSize: 26,
		color: colors.blue11,
	},
	imageCopy: {
		flex: 1,
	},
	rowTitle: {
		fontFamily: fonts.medium,
		fontSize: 16,
		color: colors.gray12,
	},
	rowSubtitle: {
		fontFamily: fonts.regular,
		fontSize: 13,
		color: colors.gray9,
		marginTop: 2,
	},
	field: {
		gap: 8,
	},
	label: {
		fontFamily: fonts.medium,
		fontSize: 14,
		color: colors.gray12,
	},
	input: {
		minHeight: 46,
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
	error: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.red10,
		textAlign: "center",
		marginTop: 12,
	},
	success: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.green9,
		textAlign: "center",
		marginTop: 12,
	},
	saveButton: {
		marginTop: 16,
	},
});

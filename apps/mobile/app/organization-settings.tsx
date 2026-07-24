import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useRef, useState } from "react";
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
import type { MobileOrganizationSettings } from "@/api/mobile";
import { MobileApiError } from "@/api/mobile";
import { useAuth } from "@/auth/AuthContext";
import { SignInPanel } from "@/auth/SignInPanel";
import { ActionButton } from "@/components/ActionButton";
import { CapLoadingIndicator } from "@/components/CapLoadingIndicator";
import { GlassSurface } from "@/components/GlassSurface";
import { Screen } from "@/components/Screen";
import { colors, fonts, radius, squircle } from "@/theme";

const maxIconBytes = 1024 * 1024;

const settingsErrorMessage = (error: unknown) => {
	if (error instanceof MobileApiError && error.status === 403) {
		return "Only organization owners and admins can make this change.";
	}
	return "Organization settings could not be updated. Try again.";
};

const openPhotoSettings = () => {
	if (Platform.OS === "ios") {
		ActionSheetIOS.showActionSheetWithOptions(
			{
				cancelButtonIndex: 1,
				message: "Allow Cap to choose an organization icon from Settings.",
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
		"Allow Cap to choose an organization icon from Settings.",
		[
			{ text: "Cancel", style: "cancel" },
			{ text: "Open Settings", onPress: () => void Linking.openSettings() },
		],
	);
};

export default function OrganizationSettingsScreen() {
	const auth = useAuth();
	const [settings, setSettings] = useState<MobileOrganizationSettings | null>(
		null,
	);
	const [name, setName] = useState("");
	const [allowedEmailDomain, setAllowedEmailDomain] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [iconBusy, setIconBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const requestRef = useRef(0);

	const load = useCallback(() => {
		if (auth.status !== "signedIn") {
			setLoading(false);
			return;
		}
		const requestId = ++requestRef.current;
		setLoading(true);
		setError(null);
		auth.client
			.getOrganizationSettings()
			.then((response) => {
				if (requestRef.current !== requestId) return;
				setSettings(response);
				setName(response.name);
				setAllowedEmailDomain(response.allowedEmailDomain ?? "");
			})
			.catch((cause: unknown) => {
				if (requestRef.current === requestId) {
					setError(settingsErrorMessage(cause));
				}
			})
			.finally(() => {
				if (requestRef.current === requestId) setLoading(false);
			});
	}, [auth.client, auth.status]);

	useEffect(() => {
		load();
		return () => {
			requestRef.current += 1;
		};
	}, [load]);

	const dirty =
		settings !== null &&
		(name.trim() !== settings.name ||
			allowedEmailDomain.trim() !== (settings.allowedEmailDomain ?? ""));
	const busy = saving || iconBusy;

	const save = async () => {
		if (!settings?.canManage || saving || !name.trim()) return;
		setSaving(true);
		setError(null);
		try {
			const response = await auth.client.updateOrganizationSettings({
				name: name.trim(),
				allowedEmailDomain: allowedEmailDomain.trim() || null,
			});
			setSettings(response);
			setName(response.name);
			setAllowedEmailDomain(response.allowedEmailDomain ?? "");
			void auth.refresh().catch(() => undefined);
		} catch (cause) {
			setError(settingsErrorMessage(cause));
		} finally {
			setSaving(false);
		}
	};

	const chooseIcon = async () => {
		if (!settings?.canManage || busy) return;
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
		const contentType = asset.mimeType?.toLowerCase() ?? "image/jpeg";
		if (contentType !== "image/jpeg" && contentType !== "image/png") {
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
				: `organization-${Date.now()}.${expectedExtensions[0]}`;
		if (
			(asset.fileSize && asset.fileSize > maxIconBytes) ||
			asset.base64.length > Math.ceil((maxIconBytes * 4) / 3) + 4
		) {
			setError("Choose a PNG or JPEG that is 1 MB or smaller.");
			return;
		}

		setIconBusy(true);
		setError(null);
		try {
			const response = await auth.client.updateOrganizationIcon({
				data: asset.base64,
				contentType,
				fileName,
			});
			setSettings(response);
			void auth.refresh().catch(() => undefined);
		} catch (cause) {
			setError(settingsErrorMessage(cause));
		} finally {
			setIconBusy(false);
		}
	};

	const removeIcon = async () => {
		if (!settings?.canManage || !settings.iconUrl || busy) return;
		setIconBusy(true);
		setError(null);
		try {
			const response = await auth.client.removeOrganizationIcon();
			setSettings(response);
			void auth.refresh().catch(() => undefined);
		} catch (cause) {
			setError(settingsErrorMessage(cause));
		} finally {
			setIconBusy(false);
		}
	};

	const showIconActions = () => {
		if (!settings?.canManage || busy) return;
		const options = settings.iconUrl
			? ["Choose Photo", "Remove Icon", "Cancel"]
			: ["Choose Photo", "Cancel"];
		if (Platform.OS === "ios") {
			ActionSheetIOS.showActionSheetWithOptions(
				{
					cancelButtonIndex: options.length - 1,
					destructiveButtonIndex: settings.iconUrl ? 1 : undefined,
					options,
					title: "Organization icon",
					tintColor: colors.blue11,
					userInterfaceStyle: "light",
				},
				(index) => {
					if (index === 0) void chooseIcon();
					if (settings.iconUrl && index === 1) void removeIcon();
				},
			);
			return;
		}
		Alert.alert("Organization icon", undefined, [
			{ text: "Choose Photo", onPress: () => void chooseIcon() },
			...(settings.iconUrl
				? [
						{
							text: "Remove Icon",
							style: "destructive" as const,
							onPress: () => void removeIcon(),
						},
					]
				: []),
			{ text: "Cancel", style: "cancel" },
		]);
	};

	if (auth.status === "signedOut") {
		return (
			<Screen scroll safeEdges={["left", "right", "bottom"]}>
				<SignInPanel title="Sign in to manage your organization" />
			</Screen>
		);
	}

	return (
		<>
			<Stack.Screen
				options={{
					headerShown: true,
					title: "Organization",
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
					<Text style={styles.title}>Organization settings</Text>
					<Text style={styles.subtitle}>
						Manage the identity and link access rules for your active
						organization.
					</Text>
				</View>
				{loading ? (
					<View style={styles.state}>
						<CapLoadingIndicator />
						<Text style={styles.stateText}>Loading settings…</Text>
					</View>
				) : !settings ? (
					<View style={styles.state}>
						<SymbolView
							name="exclamationmark.triangle"
							size={30}
							tintColor={colors.red9}
						/>
						<Text style={styles.stateTitle}>Settings unavailable</Text>
						<Text style={styles.stateText}>
							{error ?? "The active organization could not be loaded."}
						</Text>
						<ActionButton
							label="Try again"
							onPress={load}
							variant="secondary"
						/>
					</View>
				) : (
					<>
						{!settings.canManage ? (
							<View style={styles.notice}>
								<SymbolView name="lock" size={18} tintColor={colors.gray10} />
								<Text style={styles.noticeText}>
									You’re a member. Owners and admins can edit these settings.
								</Text>
							</View>
						) : null}
						<GlassSurface
							fallbackStyle={styles.cardFallback}
							style={styles.card}
							tintColor={colors.gray1}
						>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Organization icon"
								accessibilityHint={
									settings.canManage ? "Opens icon actions" : undefined
								}
								accessibilityState={{
									busy: iconBusy,
									disabled: !settings.canManage || busy,
								}}
								disabled={!settings.canManage || busy}
								onPress={showIconActions}
								style={({ pressed }) => [
									styles.iconRow,
									pressed && styles.iconRowPressed,
								]}
							>
								<View style={styles.iconPreview}>
									{iconBusy ? (
										<ActivityIndicator color={colors.blue9} />
									) : settings.iconUrl ? (
										<Image
											contentFit="cover"
											source={{ uri: settings.iconUrl }}
											style={styles.iconImage}
										/>
									) : (
										<Text style={styles.iconInitial}>
											{settings.name.slice(0, 1).toUpperCase()}
										</Text>
									)}
								</View>
								<View style={styles.iconCopy}>
									<Text style={styles.rowTitle}>Organization icon</Text>
									<Text style={styles.rowSubtitle}>
										PNG or JPEG, up to 1 MB
									</Text>
								</View>
								{settings.canManage ? (
									<SymbolView
										name="chevron.right"
										size={13}
										tintColor={colors.gray9}
									/>
								) : null}
							</Pressable>
							<View style={styles.field}>
								<Text style={styles.label}>Organization name</Text>
								<TextInput
									accessibilityLabel="Organization name"
									autoCapitalize="words"
									editable={settings.canManage && !busy}
									maxLength={255}
									onChangeText={setName}
									placeholder="Organization name"
									placeholderTextColor={colors.gray8}
									style={styles.input}
									value={name}
								/>
							</View>
							<View style={styles.field}>
								<Text style={styles.label}>Email access restriction</Text>
								<Text style={styles.help}>
									Comma-separated domains or email addresses. Leave blank to
									allow anyone with the link.
								</Text>
								<TextInput
									accessibilityLabel="Email access restriction"
									autoCapitalize="none"
									autoCorrect={false}
									editable={settings.canManage && !busy}
									maxLength={255}
									multiline
									onChangeText={setAllowedEmailDomain}
									placeholder="company.com, person@example.com"
									placeholderTextColor={colors.gray8}
									style={[styles.input, styles.multilineInput]}
									value={allowedEmailDomain}
								/>
							</View>
							{settings.customDomain ? (
								<View style={styles.domainRow}>
									<View style={styles.domainCopy}>
										<Text style={styles.label}>Custom domain</Text>
										<Text style={styles.domainValue}>
											{settings.customDomain}
										</Text>
									</View>
									<Text
										style={[
											styles.domainStatus,
											settings.domainVerified && styles.domainStatusVerified,
										]}
									>
										{settings.domainVerified ? "Verified" : "Pending"}
									</Text>
								</View>
							) : null}
						</GlassSurface>
						{error ? <Text style={styles.error}>{error}</Text> : null}
						{settings.canManage ? (
							<ActionButton
								disabled={!dirty || !name.trim() || iconBusy}
								label="Save changes"
								loading={saving}
								onPress={() => void save()}
								style={styles.saveButton}
								variant="blue"
							/>
						) : null}
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
		paddingHorizontal: 24,
	},
	stateTitle: {
		fontFamily: fonts.medium,
		fontSize: 18,
		color: colors.gray12,
	},
	stateText: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray10,
		textAlign: "center",
	},
	notice: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		padding: 14,
		borderRadius: radius.md,
		backgroundColor: colors.gray3,
		marginBottom: 12,
		...squircle,
	},
	noticeText: {
		flex: 1,
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray11,
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
	iconRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		margin: -4,
		padding: 4,
		borderRadius: radius.md,
		...squircle,
	},
	iconRowPressed: {
		backgroundColor: colors.gray3,
	},
	iconPreview: {
		width: 58,
		height: 58,
		borderRadius: radius.md,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.blue3,
		overflow: "hidden",
		...squircle,
	},
	iconImage: {
		width: "100%",
		height: "100%",
	},
	iconInitial: {
		fontFamily: fonts.medium,
		fontSize: 22,
		color: colors.blue11,
	},
	iconCopy: {
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
	help: {
		fontFamily: fonts.regular,
		fontSize: 13,
		lineHeight: 18,
		color: colors.gray10,
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
	multilineInput: {
		minHeight: 92,
		paddingTop: 12,
		textAlignVertical: "top",
	},
	domainRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingTop: 4,
	},
	domainCopy: {
		flex: 1,
	},
	domainValue: {
		fontFamily: fonts.regular,
		fontSize: 14,
		color: colors.gray10,
		marginTop: 3,
	},
	domainStatus: {
		fontFamily: fonts.medium,
		fontSize: 12,
		color: colors.gray11,
		backgroundColor: colors.gray3,
		borderRadius: radius.full,
		paddingHorizontal: 10,
		paddingVertical: 5,
	},
	domainStatusVerified: {
		color: colors.green9,
	},
	error: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.red10,
		textAlign: "center",
		marginTop: 12,
	},
	saveButton: {
		marginTop: 16,
	},
});

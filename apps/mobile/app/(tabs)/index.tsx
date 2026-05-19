import { FlashList } from "@shopify/flash-list";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ActionSheetIOS,
	Alert,
	Linking,
	Platform,
	Pressable,
	Share,
	StyleSheet,
	Text,
	View,
} from "react-native";
import type {
	MobileCapSummary,
	MobileCapsListResponse,
	MobileFolder,
} from "@/api/mobile";
import { MobileApiError } from "@/api/mobile";
import { apiBaseUrl, useAuth } from "@/auth/AuthContext";
import { SignInPanel } from "@/auth/SignInPanel";
import { CapSettingsSheet } from "@/caps/CapSettingsSheet";
import { showCapPasswordActions } from "@/caps/passwordActions";
import {
	PhotosPermissionDeniedError,
	saveCapVideoToPhotos,
} from "@/caps/saveCapVideo";
import { showCapTitleActions } from "@/caps/titleActions";
import { ActionButton } from "@/components/ActionButton";
import { CapCard } from "@/components/CapCard";
import { CapLogoBadge } from "@/components/CapLogoBadge";
import { CapRefreshControl } from "@/components/CapRefreshControl";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { Screen } from "@/components/Screen";
import { colors, fonts, radius, squircle } from "@/theme";

type ListItem =
	| { type: "section"; id: "folders" | "videos"; title: string }
	| { type: "folder"; folder: MobileFolder }
	| { type: "cap"; cap: MobileCapSummary };

const folderColorOptions: Array<{
	label: string;
	color: MobileFolder["color"];
}> = [
	{ label: "Normal", color: "normal" },
	{ label: "Blue", color: "blue" },
	{ label: "Red", color: "red" },
	{ label: "Yellow", color: "yellow" },
];

const folderTintByColor = {
	normal: colors.gray12,
	blue: colors.blue9,
	red: colors.red9,
	yellow: colors.yellow9,
} as const;

const getCapsErrorMessage = (error: unknown) => {
	if (error instanceof MobileApiError) {
		if (error.status === 401) return "Your session expired. Sign in again.";
		return "Cap could not load your library. Try again.";
	}
	return error instanceof Error
		? error.message
		: "Cap could not load your library. Try again.";
};

const showPhotosSettingsAlert = () => {
	if (Platform.OS === "ios") {
		ActionSheetIOS.showActionSheetWithOptions(
			{
				cancelButtonIndex: 1,
				message: "Allow Cap to save videos to Photos from Settings.",
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
		"Allow Cap to save videos to Photos from Settings.",
		[
			{ text: "Cancel", style: "cancel" },
			{
				text: "Open Settings",
				onPress: () => {
					void Linking.openSettings();
				},
			},
		],
	);
};

export default function CapsScreen() {
	const auth = useAuth();
	const [folder, setFolder] = useState<MobileFolder | null>(null);
	const [result, setResult] = useState<MobileCapsListResponse | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [savingId, setSavingId] = useState<string | null>(null);
	const [updatingSharingId, setUpdatingSharingId] = useState<string | null>(
		null,
	);
	const [settingsCap, setSettingsCap] = useState<MobileCapSummary | null>(null);
	const [creatingFolder, setCreatingFolder] = useState(false);
	const [creatingFolderName, setCreatingFolderName] = useState<string | null>(
		null,
	);

	const load = useCallback(async () => {
		if (auth.status !== "signedIn") return;
		setLoading(true);
		try {
			const response = await auth.client.listCaps({
				folderId: folder?.id ?? null,
				page: 1,
				limit: 30,
			});
			setResult(response);
			setLoadError(null);
		} catch (error) {
			setLoadError(getCapsErrorMessage(error));
		} finally {
			setLoading(false);
		}
	}, [auth, folder?.id]);

	useEffect(() => {
		void load();
	}, [load]);

	const refresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await Promise.all([auth.refresh(), load()]);
		} catch (error) {
			setLoadError(getCapsErrorMessage(error));
		} finally {
			setRefreshing(false);
		}
	}, [auth, load]);

	const confirmDeleteCap = useCallback(
		(cap: MobileCapSummary) => {
			if (auth.status !== "signedIn") return;
			const deleteCap = () => {
				void (async () => {
					setSettingsCap(null);
					await auth.client.deleteCap(cap.id);
					await Promise.all([auth.refresh(), load()]);
				})();
			};

			if (Platform.OS === "ios") {
				ActionSheetIOS.showActionSheetWithOptions(
					{
						cancelButtonIndex: 1,
						destructiveButtonIndex: 0,
						message: `${cap.title} will be removed from your library.`,
						options: ["Delete Cap", "Cancel"],
						title: "Delete Cap",
						tintColor: colors.blue11,
						userInterfaceStyle: "light",
					},
					(index) => {
						if (index === 0) deleteCap();
					},
				);
				return;
			}

			Alert.alert(
				"Delete Cap",
				`${cap.title} will be removed from your library.`,
				[
					{ text: "Cancel", style: "cancel" },
					{
						text: "Delete",
						style: "destructive",
						onPress: deleteCap,
					},
				],
			);
		},
		[auth, load],
	);

	const copyCapLink = useCallback((cap: MobileCapSummary) => {
		void Clipboard.setStringAsync(cap.shareUrl);
	}, []);

	const shareCapLink = useCallback((cap: MobileCapSummary) => {
		void Share.share({ url: cap.shareUrl, message: cap.shareUrl });
	}, []);

	const updateCapVisibility = useCallback(
		async (cap: MobileCapSummary, isPublic: boolean) => {
			if (auth.status !== "signedIn" || updatingSharingId !== null) return;
			setUpdatingSharingId(cap.id);
			try {
				const updated = await auth.client.updateCapSharing(cap.id, {
					public: isPublic,
				});
				setSettingsCap((current) =>
					current?.id === updated.id ? updated : current,
				);
				await Promise.all([auth.refresh(), load()]);
			} catch (error) {
				Alert.alert(
					"Sharing update failed",
					error instanceof Error
						? error.message
						: "Unable to update sharing for this Cap.",
				);
			} finally {
				setUpdatingSharingId(null);
			}
		},
		[auth, load, updatingSharingId],
	);

	const saveCapVideo = useCallback(
		async (cap: MobileCapSummary) => {
			if (auth.status !== "signedIn" || savingId !== null) return;
			setSavingId(cap.id);
			try {
				await saveCapVideoToPhotos(auth.client, cap.id);
			} catch (error) {
				if (error instanceof PhotosPermissionDeniedError) {
					showPhotosSettingsAlert();
					return;
				}
				Alert.alert(
					"Save failed",
					error instanceof Error ? error.message : "Unable to save this video.",
				);
			} finally {
				setSavingId(null);
			}
		},
		[auth, savingId],
	);

	const showPasswordActions = useCallback(
		(cap: MobileCapSummary) => {
			if (auth.status !== "signedIn") return;
			showCapPasswordActions({
				cap,
				client: auth.client,
				onUpdated: async (updated) => {
					setSettingsCap((current) =>
						current?.id === updated.id ? updated : current,
					);
					await Promise.all([auth.refresh(), load()]);
				},
			});
		},
		[auth, load],
	);

	const showTitleActions = useCallback(
		(cap: MobileCapSummary) => {
			if (auth.status !== "signedIn") return;
			showCapTitleActions({
				cap,
				client: auth.client,
				onUpdated: async (updated) => {
					setSettingsCap((current) =>
						current?.id === updated.id ? updated : current,
					);
					await Promise.all([auth.refresh(), load()]);
				},
			});
		},
		[auth, load],
	);

	const showCapSettings = useCallback((cap: MobileCapSummary) => {
		setSettingsCap(cap);
	}, []);

	const viewAnalytics = useCallback((cap: MobileCapSummary) => {
		const url = new URL("/dashboard/analytics", apiBaseUrl);
		url.searchParams.set("capId", cap.id);
		void WebBrowser.openBrowserAsync(url.toString());
	}, []);

	const createFolder = useCallback(
		async (name: string, color: MobileFolder["color"]) => {
			if (auth.status !== "signedIn" || creatingFolder) return;
			const trimmedName = name.trim();
			if (!trimmedName) {
				Alert.alert("Folder name required", "Enter a folder name to continue.");
				return;
			}

			setCreatingFolder(true);
			setCreatingFolderName(trimmedName);
			try {
				await auth.client.createFolder({ name: trimmedName, color });
				setFolder(null);
				await Promise.all([auth.refresh(), load()]);
			} catch (error) {
				Alert.alert(
					"Folder creation failed",
					error instanceof Error
						? error.message
						: "Unable to create this folder.",
				);
			} finally {
				setCreatingFolder(false);
				setCreatingFolderName(null);
			}
		},
		[auth, creatingFolder, load],
	);

	const showFolderColorSheet = useCallback(
		(name: string) => {
			if (Platform.OS !== "ios") {
				void createFolder(name, "normal");
				return;
			}

			const cancelButtonIndex = folderColorOptions.length;
			ActionSheetIOS.showActionSheetWithOptions(
				{
					cancelButtonIndex,
					message: name,
					options: [
						...folderColorOptions.map((option) => option.label),
						"Cancel",
					],
					title: "Folder color",
					tintColor: colors.blue11,
					userInterfaceStyle: "light",
				},
				(index) => {
					const option = folderColorOptions[index];
					if (option) void createFolder(name, option.color);
				},
			);
		},
		[createFolder],
	);

	const showNewFolderPrompt = useCallback(() => {
		if (auth.status !== "signedIn" || creatingFolder) return;

		if (Platform.OS === "ios") {
			Alert.prompt(
				"New Folder",
				"Name this folder.",
				[
					{ text: "Cancel", style: "cancel" },
					{
						text: "Next",
						onPress: (value?: string) => {
							const name = value?.trim() ?? "";
							if (!name) {
								Alert.alert(
									"Folder name required",
									"Enter a folder name to continue.",
								);
								return;
							}
							showFolderColorSheet(name);
						},
					},
				],
				"plain-text",
			);
			return;
		}

		Alert.alert("New Folder", "Create a folder named Untitled?", [
			{ text: "Cancel", style: "cancel" },
			{
				text: "Create",
				onPress: () => {
					void createFolder("Untitled", "normal");
				},
			},
		]);
	}, [auth.status, createFolder, creatingFolder, showFolderColorSheet]);

	const showSharingActions = useCallback(
		(cap: MobileCapSummary) => {
			if (updatingSharingId !== null) return;
			const visibilityAction = cap.public ? "Make private" : "Make public";

			if (Platform.OS === "ios") {
				ActionSheetIOS.showActionSheetWithOptions(
					{
						cancelButtonIndex: 3,
						message: cap.shareUrl,
						options: [visibilityAction, "Copy link", "Share link", "Cancel"],
						title: cap.public ? "Shared" : "Not shared",
						tintColor: colors.blue11,
						userInterfaceStyle: "light",
					},
					(index) => {
						if (index === 0) void updateCapVisibility(cap, !cap.public);
						if (index === 1) copyCapLink(cap);
						if (index === 2) shareCapLink(cap);
					},
				);
				return;
			}

			Alert.alert(cap.public ? "Shared" : "Not shared", cap.shareUrl, [
				{
					text: visibilityAction,
					onPress: () => void updateCapVisibility(cap, !cap.public),
				},
				{ text: "Copy link", onPress: () => copyCapLink(cap) },
				{ text: "Share link", onPress: () => shareCapLink(cap) },
				{ text: "Cancel", style: "cancel" },
			]);
		},
		[copyCapLink, shareCapLink, updateCapVisibility, updatingSharingId],
	);

	const items = useMemo<ListItem[]>(() => {
		if (!result) return [];
		const nextItems: ListItem[] = [];
		if (result.folders.length > 0) {
			nextItems.push({ type: "section", id: "folders", title: "Folders" });
			nextItems.push(
				...result.folders.map((item) => ({
					type: "folder" as const,
					folder: item,
				})),
			);
		}
		if (result.caps.length > 0) {
			nextItems.push({ type: "section", id: "videos", title: "Videos" });
			nextItems.push(
				...result.caps.map((item) => ({ type: "cap" as const, cap: item })),
			);
		}
		return nextItems;
	}, [result]);

	const userName = auth.bootstrap?.user.name?.split(" ")[0];
	const folderCreationHint = creatingFolder
		? "Folder creation is in progress"
		: "Creates a folder for organizing Caps";
	const folderCreationStatus = creatingFolder
		? `Creating folder ${creatingFolderName ?? ""}`.trim()
		: null;
	const folderCreationAccessibilityLabel = "New Folder";
	const folderCreationAccessibilityValue = folderCreationStatus
		? { text: folderCreationStatus }
		: undefined;
	const dashboardActionHint = creatingFolder
		? "Folder creation is in progress"
		: null;
	const savingCap =
		savingId !== null
			? settingsCap?.id === savingId
				? settingsCap
				: (result?.caps.find((cap) => cap.id === savingId) ?? null)
			: null;
	const updatingSharingCap =
		updatingSharingId !== null
			? settingsCap?.id === updatingSharingId
				? settingsCap
				: (result?.caps.find((cap) => cap.id === updatingSharingId) ?? null)
			: null;
	const isLibraryActionInProgress =
		savingId !== null || updatingSharingId !== null;
	const saveDisabledHint =
		savingId !== null
			? "Save is in progress"
			: "Current Cap action is in progress";
	const visibilityDisabledHint =
		updatingSharingId !== null
			? "Sharing update is in progress"
			: "Current Cap action is in progress";
	const saveDisabledAccessibilityValue = savingCap
		? `Saving video for ${savingCap.title}`
		: undefined;
	const visibilityDisabledAccessibilityValue = updatingSharingCap
		? `Updating sharing for ${updatingSharingCap.title}`
		: undefined;

	if (auth.status === "loading") {
		return <Screen title="My Caps" loading />;
	}

	if (auth.status === "signedOut") {
		return (
			<Screen scroll>
				<SignInPanel />
			</Screen>
		);
	}

	return (
		<Screen title="My Caps" loading={loading && !result}>
			{auth.bootstrap ? (
				<View style={styles.topBar}>
					<OrgSwitcher
						bootstrap={auth.bootstrap}
						onChange={async (organizationId) => {
							setFolder(null);
							await auth.setActiveOrganization(organizationId);
							await load();
						}}
					/>
				</View>
			) : null}
			<View style={styles.actions}>
				<ActionButton
					label="New Folder"
					accessibilityLabel={folderCreationAccessibilityLabel}
					accessibilityHint={folderCreationHint}
					accessibilityValue={folderCreationAccessibilityValue}
					onPress={showNewFolderPrompt}
					loading={creatingFolder}
					size="sm"
					style={styles.actionButton}
					symbol="folder.badge.plus"
					variant="dark"
				/>
				<ActionButton
					label="Import Video"
					accessibilityHint={dashboardActionHint ?? "Opens import options"}
					accessibilityValue={folderCreationAccessibilityValue}
					onPress={() => router.push("/upload")}
					disabled={creatingFolder}
					size="sm"
					style={styles.actionButton}
					symbol="square.and.arrow.up"
					variant="dark"
				/>
			</View>
			{folder ? (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Back to My Caps"
					onPress={() => setFolder(null)}
					style={styles.folderCrumb}
				>
					<Text style={styles.folderCrumbText}>My Caps</Text>
					<SymbolView
						name="chevron.right"
						size={14}
						tintColor={colors.gray9}
						weight="medium"
					/>
					<View style={styles.folderCrumbIcon}>
						<SymbolView
							name="folder.fill"
							size={20}
							tintColor={folderTintByColor[folder.color]}
							weight="medium"
						/>
					</View>
					<Text numberOfLines={1} style={styles.folderCurrent}>
						{folder.name}
					</Text>
				</Pressable>
			) : null}
			{loadError ? (
				<View
					accessibilityLabel={`Library error: ${loadError}`}
					accessibilityLiveRegion="polite"
					accessibilityRole="alert"
					style={styles.errorCard}
				>
					<View style={styles.errorIcon}>
						<SymbolView
							name="exclamationmark.triangle.fill"
							size={18}
							tintColor={colors.red9}
							weight="medium"
						/>
					</View>
					<View style={styles.errorCopy}>
						<Text style={styles.errorTitle}>Unable to load Caps</Text>
						<Text style={styles.errorText}>{loadError}</Text>
					</View>
					<ActionButton
						label="Try again"
						accessibilityHint="Reloads your Cap library"
						onPress={load}
						size="sm"
						style={styles.errorButton}
						symbol="arrow.clockwise"
					/>
				</View>
			) : null}
			{loadError && !result ? null : (
				<FlashList
					data={items}
					keyExtractor={(item) =>
						item.type === "section"
							? `section-${item.id}`
							: item.type === "folder"
								? `folder-${item.folder.id}`
								: `cap-${item.cap.id}`
					}
					refreshControl={
						<CapRefreshControl refreshing={refreshing} onRefresh={refresh} />
					}
					showsVerticalScrollIndicator={false}
					contentContainerStyle={styles.listContent}
					getItemType={(item) => item.type}
					ListEmptyComponent={
						<View style={styles.emptyState}>
							<View style={styles.emptyArt}>
								<View style={[styles.emptyArtCard, styles.emptyArtCardBack]} />
								<View style={styles.emptyArtCard} />
								<View style={styles.emptyLogo}>
									<CapLogoBadge size={52} />
								</View>
							</View>
							<Text style={styles.emptyTitle}>
								Hey{userName ? ` ${userName}` : ""}! Import your first Cap
							</Text>
							<Text style={styles.emptyText}>
								Bring videos into Cap and share them instantly.
							</Text>
							<View style={styles.emptyActions}>
								<ActionButton
									label="Import Video"
									accessibilityHint={
										dashboardActionHint ?? "Opens import options"
									}
									accessibilityValue={folderCreationAccessibilityValue}
									onPress={() => router.push("/upload")}
									disabled={creatingFolder}
									style={styles.emptyButton}
									symbol="square.and.arrow.up"
									variant="dark"
								/>
							</View>
						</View>
					}
					renderItem={({ item }) =>
						item.type === "section" ? (
							<View style={styles.sectionHeader}>
								<Text style={styles.sectionTitle}>{item.title}</Text>
							</View>
						) : item.type === "folder" ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={`Open folder ${item.folder.name}`}
								onPress={() => setFolder(item.folder)}
								style={({ pressed }) => [
									styles.folderRow,
									pressed ? styles.folderRowPressed : null,
								]}
							>
								<View style={styles.folderIcon}>
									<SymbolView
										name="folder.fill"
										size={32}
										tintColor={folderTintByColor[item.folder.color]}
										weight="medium"
									/>
								</View>
								<View style={styles.folderText}>
									<Text numberOfLines={1} style={styles.folderName}>
										{item.folder.name}
									</Text>
									<Text style={styles.folderMeta}>
										{item.folder.videoCount}{" "}
										{item.folder.videoCount === 1 ? "video" : "videos"}
									</Text>
								</View>
								<SymbolView
									name="chevron.right"
									size={14}
									tintColor={colors.gray9}
									weight="medium"
								/>
							</Pressable>
						) : (
							<CapCard
								cap={item.cap}
								onAnalyticsPress={() => viewAnalytics(item.cap)}
								onCopyPress={() => copyCapLink(item.cap)}
								onPress={() => router.push(`/caps/${item.cap.id}`)}
								onSharePress={() => shareCapLink(item.cap)}
								onVisibilityPress={() => showSharingActions(item.cap)}
								onMenuPress={() => showCapSettings(item.cap)}
								visibilityBusy={updatingSharingId === item.cap.id}
								visibilityDisabled={updatingSharingId !== null}
								visibilityDisabledHint={
									updatingSharingId === item.cap.id
										? "Sharing update is in progress"
										: "Another sharing update is in progress"
								}
								visibilityAccessibilityValue={
									updatingSharingId === item.cap.id
										? `Updating sharing for ${item.cap.title}`
										: undefined
								}
							/>
						)
					}
				/>
			)}
			<CapSettingsSheet
				cap={settingsCap}
				visible={settingsCap !== null}
				onClose={() => setSettingsCap(null)}
				onCopyLink={copyCapLink}
				onDelete={confirmDeleteCap}
				onPassword={showPasswordActions}
				onRename={showTitleActions}
				onSaveVideo={(cap) => {
					void saveCapVideo(cap);
				}}
				onShareLink={shareCapLink}
				onViewAnalytics={viewAnalytics}
				onVisibilityChange={(cap, isPublic) => {
					void updateCapVisibility(cap, isPublic);
				}}
				saveDisabled={isLibraryActionInProgress}
				saveDisabledHint={saveDisabledHint}
				saveDisabledValue={savingId !== null ? undefined : "Unavailable"}
				saveDisabledAccessibilityValue={saveDisabledAccessibilityValue}
				visibilityDisabled={isLibraryActionInProgress}
				visibilityDisabledHint={visibilityDisabledHint}
				visibilityDisabledAccessibilityValue={
					visibilityDisabledAccessibilityValue
				}
			/>
		</Screen>
	);
}

const styles = StyleSheet.create({
	topBar: {
		marginBottom: 12,
	},
	actions: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
		marginBottom: 40,
	},
	actionButton: {
		flexGrow: 1,
		flexBasis: 104,
		paddingHorizontal: 12,
	},
	listContent: {
		paddingBottom: 22,
	},
	folderCrumb: {
		minHeight: 40,
		flexDirection: "row",
		alignItems: "center",
		gap: 7,
		marginBottom: 14,
	},
	folderCrumbText: {
		fontFamily: fonts.medium,
		color: colors.gray9,
		fontSize: 20,
		lineHeight: 26,
	},
	folderCrumbIcon: {
		width: 24,
		height: 24,
		alignItems: "center",
		justifyContent: "center",
	},
	folderCurrent: {
		flex: 1,
		fontFamily: fonts.medium,
		color: colors.gray12,
		fontSize: 20,
		lineHeight: 26,
	},
	folderRow: {
		minHeight: 82,
		flexDirection: "row",
		alignItems: "center",
		borderRadius: radius.sm,
		borderWidth: StyleSheet.hairlineWidth,
		paddingHorizontal: 16,
		paddingVertical: 16,
		gap: 12,
		marginBottom: 12,
		backgroundColor: colors.gray3,
		borderColor: colors.gray5,
		...squircle,
	},
	folderRowPressed: {
		backgroundColor: colors.gray4,
		borderColor: colors.gray6,
	},
	sectionHeader: {
		paddingTop: 8,
		paddingBottom: 24,
	},
	sectionTitle: {
		fontFamily: fonts.medium,
		fontSize: 24,
		lineHeight: 30,
		color: colors.gray12,
	},
	folderIcon: {
		width: 50,
		height: 50,
		alignItems: "center",
		justifyContent: "center",
	},
	folderText: {
		flex: 1,
		minWidth: 0,
	},
	folderName: {
		fontFamily: fonts.regular,
		fontSize: 15,
		lineHeight: 22,
		color: colors.gray12,
	},
	folderMeta: {
		fontFamily: fonts.regular,
		fontSize: 13,
		lineHeight: 18,
		color: colors.gray10,
	},
	errorCard: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		backgroundColor: colors.gray1,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		padding: 14,
		marginBottom: 14,
		...squircle,
	},
	errorIcon: {
		width: 36,
		height: 36,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.gray3,
		...squircle,
	},
	errorCopy: {
		flex: 1,
		minWidth: 0,
	},
	errorTitle: {
		fontFamily: fonts.medium,
		fontSize: 15,
		lineHeight: 20,
		color: colors.gray12,
	},
	errorText: {
		fontFamily: fonts.regular,
		fontSize: 13,
		lineHeight: 18,
		color: colors.gray10,
		marginTop: 2,
	},
	errorButton: {
		paddingHorizontal: 14,
	},
	emptyState: {
		alignItems: "center",
		paddingTop: 42,
		gap: 12,
		paddingHorizontal: 8,
	},
	emptyArt: {
		width: 180,
		height: 112,
		alignItems: "center",
		justifyContent: "center",
		marginBottom: 10,
	},
	emptyArtCard: {
		position: "absolute",
		width: 152,
		height: 86,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		backgroundColor: colors.gray1,
		transform: [{ rotate: "-4deg" }],
		...squircle,
	},
	emptyArtCardBack: {
		backgroundColor: colors.gray3,
		borderColor: colors.gray4,
		transform: [{ translateX: 12 }, { translateY: 7 }, { rotate: "5deg" }],
	},
	emptyLogo: {
		width: 72,
		height: 72,
		borderRadius: radius.lg,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.white,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		...squircle,
	},
	emptyTitle: {
		fontFamily: fonts.medium,
		fontSize: 20,
		color: colors.gray12,
		textAlign: "center",
	},
	emptyText: {
		fontFamily: fonts.regular,
		fontSize: 15,
		lineHeight: 22,
		color: colors.gray10,
		textAlign: "center",
	},
	emptyActions: {
		width: "100%",
		flexDirection: "row",
		gap: 10,
		marginTop: 4,
	},
	emptyButton: {
		flex: 1,
	},
});

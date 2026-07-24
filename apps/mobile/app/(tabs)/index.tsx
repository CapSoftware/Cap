import { FlashList } from "@shopify/flash-list";
import * as Clipboard from "expo-clipboard";
import { router, useFocusEffect } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActionSheetIOS,
	ActivityIndicator,
	Alert,
	Linking,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	Share,
	StyleSheet,
	Text,
	View,
} from "react-native";
import type {
	MobileCapSummary,
	MobileCapsListResponse,
	MobileFolder,
	MobileSpace,
} from "@/api/mobile";
import { MobileApiError } from "@/api/mobile";
import { useAuth } from "@/auth/AuthContext";
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
import {
	CapRefreshControl,
	CapRefreshOverlay,
} from "@/components/CapRefreshControl";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { Screen } from "@/components/Screen";
import { colors, fonts, radius, squircle } from "@/theme";
import { useRecordingUploadLibraryRevision } from "@/uploads/recording-upload-provider";

type ListItem =
	| { type: "section"; id: "folders"; title: string }
	| { type: "space-switcher" }
	| { type: "folder-crumb"; folder: MobileFolder }
	| { type: "error"; message: string }
	| { type: "folder"; folder: MobileFolder }
	| { type: "cap"; cap: MobileCapSummary }
	| { type: "empty" };

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

const activeUploadPhases = new Set([
	"uploading",
	"processing",
	"generating_thumbnail",
]);
const processingRefreshIntervalMs = 3000;
const statusBatchSize = 25;
const stickyHeaderIndices = [0];

const uploadsMatch = (
	left: MobileCapSummary["upload"],
	right: MobileCapSummary["upload"],
) =>
	left === right ||
	(left !== null &&
		right !== null &&
		left.uploaded === right.uploaded &&
		left.total === right.total &&
		left.phase === right.phase &&
		left.processingProgress === right.processingProgress &&
		left.processingMessage === right.processingMessage &&
		left.processingError === right.processingError);

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

const formatSpaceRole = (role: MobileSpace["role"]) =>
	role ? role.slice(0, 1).toUpperCase() + role.slice(1) : null;

function SpaceSwitcher({
	spaces,
	selectedSpaceId,
	capCount,
	onChange,
}: {
	spaces: readonly MobileSpace[];
	selectedSpaceId: string | null;
	capCount: number | null;
	onChange: (spaceId: string | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const selectedSpace = spaces.find((space) => space.id === selectedSpaceId);
	const selectedLabel = selectedSpace?.name ?? "My Caps";
	const capCountLabel =
		capCount === null ? null : `${capCount} ${capCount === 1 ? "cap" : "caps"}`;
	const options = useMemo(
		() => [
			{ id: null, label: "My Caps" },
			...spaces.map((space) => ({
				id: space.id,
				label: `${space.name}${space.hasPassword ? " · Locked" : ""}${formatSpaceRole(space.role) ? ` · ${formatSpaceRole(space.role)}` : ""}`,
			})),
		],
		[spaces],
	);

	const openSwitcher = () => {
		if (Platform.OS === "ios") {
			const activeIndex = options.findIndex(
				(option) => option.id === selectedSpaceId,
			);
			ActionSheetIOS.showActionSheetWithOptions(
				{
					cancelButtonIndex: options.length,
					disabledButtonIndices: activeIndex >= 0 ? [activeIndex] : undefined,
					disabledButtonTintColor: colors.gray9,
					message: selectedLabel,
					options: [...options.map((option) => option.label), "Cancel"],
					title: "Space",
					tintColor: colors.blue11,
					userInterfaceStyle: "light",
				},
				(index) => {
					const option = options[index];
					if (option && option.id !== selectedSpaceId) onChange(option.id);
				},
			);
			return;
		}
		setOpen(true);
	};

	return (
		<>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel="Switch space"
				accessibilityHint="Shows My Caps and available spaces"
				accessibilityValue={{
					text: capCountLabel
						? `${selectedLabel}, ${capCountLabel}`
						: selectedLabel,
				}}
				onPress={openSwitcher}
				style={({ pressed }) => [
					styles.spaceTrigger,
					pressed ? styles.spaceTriggerPressed : null,
				]}
			>
				<View style={styles.spaceTriggerLabel}>
					<Text numberOfLines={1} style={styles.spaceTriggerText}>
						{selectedLabel}
					</Text>
					<SymbolView
						name="chevron.up.chevron.down"
						size={15}
						tintColor={colors.gray10}
						weight="semibold"
					/>
				</View>
				{capCountLabel ? (
					<Text style={styles.spaceCapCount}>{capCountLabel}</Text>
				) : null}
			</Pressable>
			<Modal
				allowSwipeDismissal
				animationType="slide"
				onRequestClose={() => setOpen(false)}
				onDismiss={() => setOpen(false)}
				presentationStyle="formSheet"
				visible={open}
			>
				<View style={styles.spaceSheet}>
					<View style={styles.spaceSheetHeader}>
						<Text style={styles.spaceSheetTitle}>Choose a space</Text>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Close space selector"
							onPress={() => setOpen(false)}
							style={styles.spaceSheetClose}
						>
							<SymbolView
								name="xmark"
								size={15}
								tintColor={colors.gray11}
								weight="semibold"
							/>
						</Pressable>
					</View>
					<ScrollView contentContainerStyle={styles.spaceSheetContent}>
						{options.map((option) => {
							const space = option.id
								? spaces.find((item) => item.id === option.id)
								: null;
							const selected = option.id === selectedSpaceId;
							const detail = space
								? space.kind === "organization"
									? `Organization${formatSpaceRole(space.role) ? ` · ${formatSpaceRole(space.role)}` : ""}`
									: `${space.privacy} space${formatSpaceRole(space.role) ? ` · ${formatSpaceRole(space.role)}` : ""}`
								: "Personal library";
							return (
								<Pressable
									key={option.id ?? "my-caps"}
									accessibilityRole="button"
									accessibilityState={{ selected }}
									onPress={() => {
										setOpen(false);
										if (!selected) onChange(option.id);
									}}
									style={({ pressed }) => [
										styles.spaceRow,
										pressed ? styles.spaceRowPressed : null,
									]}
								>
									<View style={styles.spaceRowIcon}>
										<SymbolView
											name={
												space?.hasPassword
													? "lock.fill"
													: space?.kind === "organization"
														? "building.2.fill"
														: space
															? "person.3.fill"
															: "person.fill"
											}
											size={17}
											tintColor={colors.blue11}
											weight="medium"
										/>
									</View>
									<View style={styles.spaceRowCopy}>
										<Text numberOfLines={1} style={styles.spaceRowName}>
											{option.id === null ? option.label : space?.name}
										</Text>
										<Text numberOfLines={1} style={styles.spaceRowDetail}>
											{detail}
										</Text>
									</View>
									{selected ? (
										<SymbolView
											name="checkmark"
											size={18}
											tintColor={colors.blue11}
											weight="semibold"
										/>
									) : null}
								</Pressable>
							);
						})}
					</ScrollView>
				</View>
			</Modal>
		</>
	);
}

export default function CapsScreen() {
	const auth = useAuth();
	const authStatus = auth.status;
	const apiClient = auth.client;
	const libraryRevision = useRecordingUploadLibraryRevision();
	const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
	const [folder, setFolder] = useState<MobileFolder | null>(null);
	const [result, setResult] = useState<MobileCapsListResponse | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [loading, setLoading] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
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
	const backgroundLoadInFlight = useRef(false);
	const loadMoreInFlight = useRef(false);
	const loadRequestId = useRef(0);
	const spaces = auth.bootstrap?.spaces ?? [];
	const selectedSpace = spaces.find((space) => space.id === selectedSpaceId);
	const selectedCollectionName = selectedSpace?.name ?? "My Caps";
	const canManageSelectedCollection = selectedSpace?.canManage ?? true;
	const thumbnailAuthorization = auth.apiKey
		? `Bearer ${auth.apiKey}`
		: undefined;

	useEffect(() => {
		if (selectedSpaceId && !selectedSpace) {
			loadRequestId.current += 1;
			setSelectedSpaceId(null);
			setFolder(null);
			setResult(null);
		}
	}, [selectedSpace, selectedSpaceId]);

	const load = useCallback(
		async (showLoading = true) => {
			if (authStatus !== "signedIn") return;
			const requestId = ++loadRequestId.current;
			if (showLoading) setLoading(true);
			try {
				const response = await apiClient.listCaps({
					folderId: folder?.id ?? null,
					spaceId: selectedSpaceId,
					page: 1,
					limit: 30,
				});
				if (requestId !== loadRequestId.current) return;
				setResult(response);
				setLoadError(null);
			} catch (error) {
				if (requestId !== loadRequestId.current) return;
				setLoadError(getCapsErrorMessage(error));
			} finally {
				if (showLoading && requestId === loadRequestId.current) {
					setLoading(false);
				}
			}
		},
		[apiClient, authStatus, folder?.id, selectedSpaceId],
	);

	useFocusEffect(
		useCallback(() => {
			void load(libraryRevision === 0);
		}, [libraryRevision, load]),
	);

	const loadMore = useCallback(async () => {
		if (
			authStatus !== "signedIn" ||
			loading ||
			refreshing ||
			loadMoreInFlight.current ||
			!result?.hasMore
		) {
			return;
		}

		const requestId = loadRequestId.current;
		const currentPage = result.page;
		loadMoreInFlight.current = true;
		setLoadingMore(true);
		try {
			const response = await apiClient.listCaps({
				folderId: folder?.id ?? null,
				spaceId: selectedSpaceId,
				page: currentPage + 1,
				limit: result.limit,
			});
			if (requestId !== loadRequestId.current) return;
			setResult((current) => {
				if (!current || current.page !== currentPage) return current;
				const capIds = new Set(current.caps.map((cap) => cap.id));
				return {
					...current,
					caps: [
						...current.caps,
						...response.caps.filter((cap) => !capIds.has(cap.id)),
					],
					page: response.page,
					total: response.total,
					collectionTotal: response.collectionTotal,
					hasMore: response.hasMore,
				};
			});
		} catch (error) {
			if (requestId === loadRequestId.current) {
				setLoadError(getCapsErrorMessage(error));
			}
		} finally {
			loadMoreInFlight.current = false;
			setLoadingMore(false);
		}
	}, [
		apiClient,
		authStatus,
		folder?.id,
		loading,
		refreshing,
		result,
		selectedSpaceId,
	]);

	const activeCapIds = useMemo(
		() =>
			result?.caps.flatMap((cap) =>
				cap.ownedByCurrentUser !== false &&
				cap.upload &&
				activeUploadPhases.has(cap.upload.phase)
					? [cap.id]
					: [],
			) ?? [],
		[result],
	);
	const activeCapIdsKey = activeCapIds.join(",");

	useFocusEffect(
		useCallback(() => {
			if (authStatus !== "signedIn" || activeCapIdsKey.length === 0) return;
			const ids = activeCapIdsKey.split(",");
			let cancelled = false;
			const poll = async () => {
				if (backgroundLoadInFlight.current) return;
				backgroundLoadInFlight.current = true;
				try {
					const responses = await Promise.all(
						Array.from(
							{ length: Math.ceil(ids.length / statusBatchSize) },
							(_, index) =>
								apiClient.getCapStatuses(
									ids.slice(
										index * statusBatchSize,
										(index + 1) * statusBatchSize,
									),
								),
						),
					);
					if (cancelled) return;
					const responseCaps = responses.flatMap((response) => response.caps);
					const statuses = new Map(
						responseCaps.map((cap) => [cap.id, cap.upload]),
					);
					setResult((current) => {
						if (!current) return current;
						let changed = false;
						const caps = current.caps.map((cap) => {
							if (!statuses.has(cap.id)) return cap;
							const upload = statuses.get(cap.id) ?? null;
							if (uploadsMatch(cap.upload, upload)) return cap;
							changed = true;
							return { ...cap, upload };
						});
						return changed ? { ...current, caps } : current;
					});
					const terminal =
						responseCaps.length !== ids.length ||
						responseCaps.some(
							(cap) => !cap.upload || !activeUploadPhases.has(cap.upload.phase),
						);
					if (terminal) await load(false);
				} catch {
				} finally {
					backgroundLoadInFlight.current = false;
				}
			};
			void poll();
			const timer = setInterval(() => {
				void poll();
			}, processingRefreshIntervalMs);
			return () => {
				cancelled = true;
				clearInterval(timer);
			};
		}, [activeCapIdsKey, apiClient, authStatus, load]),
	);

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
	const openCap = useCallback((cap: MobileCapSummary) => {
		router.push(`/caps/${cap.id}`);
	}, []);

	const viewAnalytics = useCallback((cap: MobileCapSummary) => {
		router.push({ pathname: "/analytics", params: { capId: cap.id } });
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
				await auth.client.createFolder({
					name: trimmedName,
					color,
					spaceId: selectedSpace?.id,
				});
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
		[auth, creatingFolder, load, selectedSpace],
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
		const nextItems: ListItem[] = [{ type: "space-switcher" }];
		if (folder) nextItems.push({ type: "folder-crumb", folder });
		if (loadError) nextItems.push({ type: "error", message: loadError });
		if (!result) return nextItems;
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
			nextItems.push(
				...result.caps.map((item) => ({ type: "cap" as const, cap: item })),
			);
		} else {
			nextItems.push({ type: "empty" });
		}
		return nextItems;
	}, [folder, loadError, result]);

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
	const isEmptyMyCaps =
		selectedSpaceId === null &&
		folder === null &&
		result !== null &&
		result.folders.length === 0 &&
		result.caps.length === 0;
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
		return <Screen loading />;
	}

	if (auth.status === "signedOut") {
		return (
			<Screen scroll>
				<SignInPanel />
			</Screen>
		);
	}

	return (
		<Screen loading={loading && !result}>
			<View style={styles.listWrap}>
				<FlashList
					ListHeaderComponent={
						<>
							{auth.bootstrap ? (
								<View style={styles.topBar}>
									<OrgSwitcher
										bootstrap={auth.bootstrap}
										onChange={async (organizationId) => {
											loadRequestId.current += 1;
											setSelectedSpaceId(null);
											setFolder(null);
											setResult(null);
											await auth.setActiveOrganization(organizationId);
										}}
									/>
								</View>
							) : null}
							{canManageSelectedCollection || selectedSpaceId === null ? (
								<View style={styles.actions}>
									{canManageSelectedCollection ? (
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
									) : null}
									{selectedSpaceId === null &&
									result &&
									(result.folders.length > 0 || result.caps.length > 0) ? (
										<ActionButton
											label="Import Media"
											accessibilityHint={
												dashboardActionHint ?? "Opens import options"
											}
											accessibilityValue={folderCreationAccessibilityValue}
											onPress={() => router.push("/upload")}
											disabled={creatingFolder}
											size="sm"
											style={styles.actionButton}
											symbol="square.and.arrow.up"
											variant="dark"
										/>
									) : null}
								</View>
							) : null}
						</>
					}
					data={items}
					ListFooterComponent={
						loadingMore ? (
							<View style={styles.listFooter}>
								<ActivityIndicator color={colors.blue11} />
							</View>
						) : null
					}
					keyExtractor={(item) =>
						item.type === "section"
							? `section-${item.id}`
							: item.type === "space-switcher"
								? "space-switcher"
								: item.type === "folder-crumb"
									? `folder-crumb-${item.folder.id}`
									: item.type === "error"
										? "error"
										: item.type === "folder"
											? `folder-${item.folder.id}`
											: item.type === "empty"
												? `empty-${selectedSpaceId ?? "my-caps"}-${folder?.id ?? "root"}`
												: `cap-${item.cap.id}`
					}
					refreshControl={
						<CapRefreshControl refreshing={refreshing} onRefresh={refresh} />
					}
					showsVerticalScrollIndicator={false}
					contentContainerStyle={styles.listContent}
					getItemType={(item) => item.type}
					onEndReached={() => {
						void loadMore();
					}}
					onEndReachedThreshold={0.4}
					stickyHeaderIndices={stickyHeaderIndices}
					renderItem={({ item }) =>
						item.type === "section" ? (
							<View style={styles.sectionHeader}>
								<Text style={styles.sectionTitle}>{item.title}</Text>
							</View>
						) : item.type === "space-switcher" ? (
							<View style={styles.spaceSwitcherRow}>
								<SpaceSwitcher
									spaces={spaces}
									selectedSpaceId={selectedSpaceId}
									capCount={result?.collectionTotal ?? result?.total ?? null}
									onChange={(spaceId) => {
										loadRequestId.current += 1;
										setSelectedSpaceId(spaceId);
										setFolder(null);
										setResult(null);
										setLoadError(null);
									}}
								/>
							</View>
						) : item.type === "folder-crumb" ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={`Back to ${selectedCollectionName}`}
								onPress={() => setFolder(null)}
								style={styles.folderCrumb}
							>
								<Text style={styles.folderCrumbText}>
									{selectedCollectionName}
								</Text>
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
										tintColor={folderTintByColor[item.folder.color]}
										weight="medium"
									/>
								</View>
								<Text numberOfLines={1} style={styles.folderCurrent}>
									{item.folder.name}
								</Text>
							</Pressable>
						) : item.type === "error" ? (
							<View
								accessibilityLabel={`Library error: ${item.message}`}
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
									<Text style={styles.errorText}>{item.message}</Text>
								</View>
								<ActionButton
									label="Try again"
									accessibilityHint="Reloads your Cap library"
									onPress={() => {
										void load();
									}}
									size="sm"
									style={styles.errorButton}
									symbol="arrow.clockwise"
								/>
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
						) : item.type === "empty" ? (
							<View style={styles.emptyState}>
								<View style={styles.emptyArt}>
									<View
										style={[styles.emptyArtCard, styles.emptyArtCardBack]}
									/>
									<View style={styles.emptyArtCard} />
									<View style={styles.emptyLogo}>
										<CapLogoBadge size={52} />
									</View>
								</View>
								<Text style={styles.emptyTitle}>
									{isEmptyMyCaps
										? "Welcome! Record or Import your first Cap"
										: folder
											? `No Caps in ${folder.name}`
											: `No Caps in ${selectedCollectionName}`}
								</Text>
								<Text style={styles.emptyText}>
									{isEmptyMyCaps
										? "Bring videos into Cap and share them instantly."
										: "Caps added to this space will appear here."}
								</Text>
								{isEmptyMyCaps ? (
									<View style={styles.emptyActions}>
										<ActionButton
											label="Record"
											accessibilityLabel="Record"
											accessibilityHint="Opens the camera recorder"
											onPress={() => router.push("/record")}
											disabled={creatingFolder}
											style={styles.emptyButton}
											symbol="video.fill"
											variant="dark"
										/>
										<ActionButton
											label="Import Media"
											accessibilityHint={
												dashboardActionHint ?? "Opens import options"
											}
											accessibilityValue={folderCreationAccessibilityValue}
											onPress={() => router.push("/upload")}
											disabled={creatingFolder}
											style={styles.emptyButton}
											symbol="square.and.arrow.up"
											variant="secondary"
										/>
									</View>
								) : null}
							</View>
						) : (
							<CapCard
								cap={item.cap}
								thumbnailAuthorization={thumbnailAuthorization}
								onAnalyticsPress={
									item.cap.ownedByCurrentUser !== false
										? viewAnalytics
										: undefined
								}
								onCopyPress={copyCapLink}
								onPress={openCap}
								onSharePress={shareCapLink}
								onVisibilityPress={
									item.cap.ownedByCurrentUser !== false
										? showSharingActions
										: undefined
								}
								onMenuPress={
									item.cap.ownedByCurrentUser !== false
										? showCapSettings
										: undefined
								}
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
				<CapRefreshOverlay refreshing={refreshing} />
			</View>
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
	listWrap: {
		flex: 1,
	},
	listContent: {
		paddingBottom: 112,
	},
	listFooter: {
		alignItems: "center",
		paddingVertical: 20,
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
	spaceSwitcherRow: {
		paddingTop: 8,
		paddingBottom: 24,
		backgroundColor: colors.gray1,
	},
	spaceTrigger: {
		alignSelf: "stretch",
		maxWidth: "100%",
		minHeight: 36,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 16,
		borderRadius: radius.sm,
		paddingHorizontal: 2,
		...squircle,
	},
	spaceTriggerLabel: {
		minWidth: 0,
		flexShrink: 1,
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	spaceTriggerPressed: {
		opacity: 0.62,
	},
	spaceTriggerText: {
		flexShrink: 1,
		fontFamily: fonts.medium,
		fontSize: 24,
		lineHeight: 30,
		color: colors.gray12,
	},
	spaceCapCount: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray9,
	},
	spaceSheet: {
		flex: 1,
		backgroundColor: colors.gray1,
		paddingTop: 18,
	},
	spaceSheetHeader: {
		minHeight: 48,
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 20,
		paddingBottom: 10,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.gray4,
	},
	spaceSheetTitle: {
		flex: 1,
		fontFamily: fonts.medium,
		fontSize: 22,
		lineHeight: 28,
		color: colors.gray12,
	},
	spaceSheetClose: {
		width: 32,
		height: 32,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.gray3,
	},
	spaceSheetContent: {
		padding: 14,
		paddingBottom: 32,
	},
	spaceRow: {
		minHeight: 64,
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		borderRadius: radius.sm,
		paddingHorizontal: 10,
		paddingVertical: 8,
		...squircle,
	},
	spaceRowPressed: {
		backgroundColor: colors.gray3,
	},
	spaceRowIcon: {
		width: 36,
		height: 36,
		borderRadius: radius.sm,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.blue3,
		...squircle,
	},
	spaceRowCopy: {
		flex: 1,
		minWidth: 0,
		gap: 2,
	},
	spaceRowName: {
		fontFamily: fonts.medium,
		fontSize: 16,
		color: colors.gray12,
	},
	spaceRowDetail: {
		fontFamily: fonts.regular,
		fontSize: 12,
		color: colors.gray9,
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

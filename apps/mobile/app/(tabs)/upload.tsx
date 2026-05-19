import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useReducer, useRef, useState } from "react";
import {
	ActionSheetIOS,
	ActivityIndicator,
	Alert,
	Linking,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import type { UploadFile } from "@/api/mobile";
import { apiBaseUrl, useAuth } from "@/auth/AuthContext";
import { SignInPanel } from "@/auth/SignInPanel";
import { ActionButton } from "@/components/ActionButton";
import { GlassSurface } from "@/components/GlassSurface";
import { Screen } from "@/components/Screen";
import { colors, fonts, radius, squircle } from "@/theme";
import { contentTypeForUpload } from "@/uploads/fileTypes";
import { runMobileUpload } from "@/uploads/runMobileUpload";
import {
	emptyUploadQueue,
	isTerminalUploadQueueAction,
	type UploadQueueItem,
	uploadProgressPercent,
	uploadQueueActionFromCapUpload,
	uploadQueueReducer,
	uploadQueueStatusText,
} from "@/uploads/uploadQueue";
import { formatDuration, formatFileSize } from "@/utils/format";

const processingPollDelaysMs = [1500, 3000, 5000, 8000] as const;
const photosAccessNeededMessage =
	"Allow Cap to read videos from Photos before uploading.";
const uploadAcceptedFormats = "MP4, MOV, AVI, MKV, WebM, or M4V";
type UploadSourceLoading = "files" | "loom" | "photos" | null;
type UploadSource = Exclude<UploadSourceLoading, null>;
type UploadSourceError = {
	message: string;
	source: UploadSource;
};

const queueItemFromFile = (
	file: UploadFile,
	organizationId: string | null,
): Omit<UploadQueueItem, "createdAt" | "updatedAt"> => ({
	id: `${Date.now()}-${file.name}`,
	localUri: file.uri,
	fileName: file.name,
	contentType: file.type,
	size: file.size ?? 0,
	durationSeconds: file.durationSeconds,
	width: file.width,
	height: file.height,
	folderId: null,
	organizationId,
	status: "queued",
	progress: 0,
	error: null,
	capId: null,
	rawFileKey: null,
	processingMessage: null,
});

const showPhotosSettingsAlert = () => {
	if (Platform.OS === "ios") {
		ActionSheetIOS.showActionSheetWithOptions(
			{
				cancelButtonIndex: 1,
				message: photosAccessNeededMessage,
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

	Alert.alert("Photos access needed", photosAccessNeededMessage, [
		{ text: "Cancel", style: "cancel" },
		{
			text: "Open Settings",
			onPress: () => {
				void Linking.openSettings();
			},
		},
	]);
};

const getUploadSourceErrorMessage = (error: unknown, source: UploadSource) =>
	error instanceof Error
		? error.message
		: source === "loom"
			? "Unable to open Loom import"
			: "Unable to open the picker";

const uploadQueueMetadataText = (
	item: UploadQueueItem,
	statusText = uploadQueueStatusText(item),
) => {
	const failureReason =
		item.status === "failed" && item.error?.trim() ? item.error.trim() : null;
	return [
		statusText,
		failureReason,
		formatFileSize(item.size),
		formatDuration(item.durationSeconds ?? null),
	]
		.filter(Boolean)
		.join(" · ");
};

const uploadQueueMenuHint = (item: UploadQueueItem) => {
	if (item.status === "failed") return "Opens retry and remove actions";
	if (
		(item.status === "processing" || item.status === "complete") &&
		item.capId
	) {
		return "Opens view and remove actions";
	}
	return "Opens remove action";
};

const uploadQueueHasProgress = (item: UploadQueueItem) =>
	item.status === "uploading" ||
	item.status === "processing" ||
	item.status === "complete";

const progressAccessibilityValue = (percent: number) => ({
	max: 100,
	min: 0,
	now: percent,
	text: `${percent}%`,
});

const LoomMark = () => (
	<Svg width={22} height={22} viewBox="0 0 16 16" fill="none">
		<Path
			fill="#625DF5"
			d="M15 7.222h-4.094l3.546-2.047-.779-1.35-3.545 2.048 2.046-3.546-1.349-.779L8.78 5.093V1H7.22v4.094L5.174 1.548l-1.348.779 2.046 3.545-3.545-2.046-.779 1.348 3.546 2.047H1v1.557h4.093l-3.545 2.047.779 1.35 3.545-2.047-2.047 3.545 1.35.779 2.046-3.546V15h1.557v-4.094l2.047 3.546 1.349-.779-2.047-3.546 3.545 2.047.779-1.349-3.545-2.046h4.093L15 7.222zm-7 2.896a2.126 2.126 0 110-4.252 2.126 2.126 0 010 4.252z"
		/>
	</Svg>
);

const idleLoomImportLabel = "Import from Loom";

export default function UploadScreen() {
	const auth = useAuth();
	const [queue, dispatch] = useReducer(uploadQueueReducer, emptyUploadQueue);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [activeUploadName, setActiveUploadName] = useState<string | null>(null);
	const [sourceError, setSourceError] = useState<UploadSourceError | null>(
		null,
	);
	const [sourceLoading, setSourceLoading] = useState<UploadSourceLoading>(null);
	const mountedRef = useRef(true);
	const activeIdRef = useRef<string | null>(null);
	const sourceBusyRef = useRef(false);
	const uploadSourceError =
		sourceError?.source === "files" || sourceError?.source === "photos"
			? sourceError.message
			: null;
	const loomImportError =
		sourceError?.source === "loom" ? sourceError.message : null;
	const activeItem = activeId
		? (queue.items.find((item) => item.id === activeId) ?? null)
		: null;
	const activeUploadFileName = activeItem?.fileName ?? activeUploadName;
	const activeUploadPreparing =
		activeId !== null &&
		(activeItem === null || activeItem.status === "queued");
	const activeProgress =
		activeItem !== null && uploadQueueHasProgress(activeItem)
			? uploadProgressPercent(activeItem.progress)
			: null;
	const activeUploadHint = activeUploadPreparing
		? "Preparing upload"
		: "Upload is in progress";
	const uploadSourceBusy = activeId !== null || sourceLoading !== null;
	const sourcePending =
		sourceLoading !== null && sourceLoading !== "loom" && activeId === null;
	const sourceLoadingTitle =
		sourcePending && sourceLoading === "files"
			? "Opening Files"
			: sourcePending && sourceLoading === "photos"
				? "Opening Photos"
				: null;
	const sourceLoadingSubtitle =
		sourcePending && sourceLoading === "files"
			? "Choose a video from Files."
			: sourcePending && sourceLoading === "photos"
				? "Choose a video from Photos."
				: null;
	const sourceLoadingAccessibilityText =
		sourceLoading === "files"
			? "Opening native file picker"
			: sourceLoading === "photos"
				? "Opening native photo picker"
				: sourceLoading === "loom"
					? "Opening Loom import"
					: null;
	const importTitle = sourceLoadingTitle ?? "Upload File";
	const importSubtitle =
		uploadSourceError ??
		sourceLoadingSubtitle ??
		(activeId !== null
			? activeUploadPreparing
				? "Preparing your video for upload."
				: "Keep Cap open while your video uploads."
			: "Upload a video file from your device");
	const loomImportTitle = loomImportError
		? "Loom import unavailable"
		: sourceLoading === "loom"
			? "Opening Loom"
			: idleLoomImportLabel;
	const loomImportSubtitle =
		loomImportError ??
		(sourceLoading === "loom"
			? "Continue in the browser sheet to import from Loom."
			: activeId !== null
				? activeUploadPreparing
					? "Finish preparing this upload before importing from Loom."
					: "Finish the current upload before importing from Loom."
				: "Import a Loom share link or bulk import from CSV");
	const activeUploadAccessibilityLabel = activeUploadFileName
		? activeUploadPreparing
			? `Preparing upload ${activeUploadFileName}`
			: activeProgress !== null
				? `Uploading ${activeUploadFileName} ${activeProgress}%`
				: `Uploading ${activeUploadFileName}`
		: null;
	const activeUploadAccessibilityValue = activeUploadAccessibilityLabel
		? { text: activeUploadAccessibilityLabel }
		: undefined;
	const showUploadFormats =
		!uploadSourceError && !sourcePending && activeId === null;
	const uploadSourceAccessibilityLabel = sourcePending
		? (sourceLoadingTitle ?? "Upload source opening")
		: uploadSourceError
			? "Upload source unavailable"
			: "Choose upload source";
	const loomImportAccessibilityLabel = loomImportError
		? "Loom import unavailable"
		: sourceLoading === "loom"
			? loomImportTitle
			: "Open Loom import";
	const uploadSourceAccessibilityValue = uploadSourceError
		? { text: uploadSourceError }
		: sourcePending && sourceLoadingAccessibilityText
			? { text: sourceLoadingAccessibilityText }
			: sourceLoading === "loom" && sourceLoadingAccessibilityText
				? { text: sourceLoadingAccessibilityText }
				: (activeUploadAccessibilityValue ?? { text: uploadAcceptedFormats });
	const loomImportAccessibilityValue = loomImportError
		? { text: loomImportError }
		: sourceLoading !== null && sourceLoadingAccessibilityText
			? { text: sourceLoadingAccessibilityText }
			: activeUploadAccessibilityValue;
	const sourceOpeningHint =
		sourceLoading === "loom"
			? "Loom import is opening"
			: "Upload source picker is opening";
	const uploadSourceActionHint = (
		source: Exclude<UploadSourceLoading, null>,
		idleHint: string,
	) => {
		if (activeId !== null) return activeUploadHint;
		if (sourceLoading === source) return sourceOpeningHint;
		if (sourceLoading !== null) {
			return sourceLoading === "loom"
				? "Loom import is opening"
				: "Another upload source is opening";
		}
		if (sourceError?.source === source) return sourceError.message;
		return idleHint;
	};
	const uploadSourceActionValue = (
		source: Exclude<UploadSourceLoading, null>,
	) => {
		if (sourceLoading !== null && sourceLoadingAccessibilityText) {
			return { text: sourceLoadingAccessibilityText };
		}
		if (sourceError?.source === source) return { text: sourceError.message };
		if (activeId !== null) {
			return activeUploadAccessibilityValue;
		}
		return undefined;
	};
	const browseFilesLabel =
		sourceError?.source === "files" ? "Retry Files" : "Browse Files";
	const photosLabel =
		sourceError?.source === "photos" ? "Retry Photos" : "Photos";
	const loomActionLabel =
		sourceError?.source === "loom" ? "Retry Loom" : "Loom";
	const loomActionAccessibilityLabel =
		sourceError?.source === "loom" ? undefined : idleLoomImportLabel;
	const uploadSourceCardBusy = activeId !== null || sourcePending;

	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);

	const dispatchIfMounted = (action: Parameters<typeof dispatch>[0]) => {
		if (mountedRef.current) dispatch(action);
	};

	const setActiveUploadId = (id: string | null, fileName?: string) => {
		activeIdRef.current = id;
		setActiveId(id);
		setActiveUploadName(id ? (fileName ?? null) : null);
	};

	const isUploadSourceBusy = () =>
		sourceBusyRef.current || activeIdRef.current !== null;

	const beginUploadSource = (source: UploadSource) => {
		if (isUploadSourceBusy()) return false;
		sourceBusyRef.current = true;
		setSourceError(null);
		setSourceLoading(source);
		return true;
	};

	const endUploadSource = () => {
		sourceBusyRef.current = false;
		setSourceLoading(null);
	};

	const waitForProcessing = async (queueItemId: string, capId: string) => {
		if (auth.status !== "signedIn") return;

		for (const delayMs of processingPollDelaysMs) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			if (!mountedRef.current) return;

			try {
				const detail = await auth.client.getCap(capId);
				const action = uploadQueueActionFromCapUpload(
					queueItemId,
					detail.cap.upload,
				);
				if (action) {
					dispatchIfMounted(action);
					if (isTerminalUploadQueueAction(action)) {
						if (action.type === "complete") {
							await auth.refresh().catch(() => undefined);
						}
						return;
					}
				}
			} catch {
				return;
			}
		}
	};

	const uploadQueueItem = async (
		item: Omit<UploadQueueItem, "createdAt" | "updatedAt"> | UploadQueueItem,
		file: UploadFile,
	) => {
		if (auth.status !== "signedIn") return;

		setActiveUploadId(item.id, item.fileName);
		try {
			const created = await runMobileUpload({
				client: auth.client,
				file,
				organizationId:
					item.organizationId ?? auth.bootstrap?.activeOrganizationId,
				folderId: item.folderId,
				onCreated: (capId, rawFileKey) =>
					dispatch({
						type: "start",
						id: item.id,
						capId,
						rawFileKey,
					}),
				onProgress: (progress) =>
					dispatch({ type: "progress", id: item.id, progress }),
			});
			dispatch({ type: "processing", id: item.id, progress: 0 });
			await auth.refresh().catch(() => undefined);
			void waitForProcessing(item.id, created.id);
		} catch (error) {
			dispatch({
				type: "fail",
				id: item.id,
				error: error instanceof Error ? error.message : "Upload failed",
			});
		} finally {
			setActiveUploadId(null);
		}
	};

	const uploadFile = async (file: UploadFile) => {
		if (auth.status !== "signedIn") return;
		setSourceError(null);

		const item = queueItemFromFile(
			file,
			auth.bootstrap?.activeOrganizationId ?? null,
		);
		dispatch({ type: "enqueue", item });
		await uploadQueueItem(item, file);
	};

	const pickFile = async () => {
		if (!beginUploadSource("files")) return;
		try {
			const result = await DocumentPicker.getDocumentAsync({
				type: "video/*",
				copyToCacheDirectory: true,
			});
			if (result.canceled || !result.assets[0]) return;
			const asset = result.assets[0];
			endUploadSource();
			await uploadFile({
				uri: asset.uri,
				name: asset.name,
				type: contentTypeForUpload(asset.name, asset.mimeType),
				size: asset.size,
			});
		} catch (error) {
			setSourceError({
				message: getUploadSourceErrorMessage(error, "files"),
				source: "files",
			});
		} finally {
			endUploadSource();
		}
	};

	const pickPhoto = async () => {
		if (!beginUploadSource("photos")) return;
		try {
			const permission =
				await ImagePicker.requestMediaLibraryPermissionsAsync();
			if (!permission.granted) {
				setSourceError({
					message: photosAccessNeededMessage,
					source: "photos",
				});
				showPhotosSettingsAlert();
				return;
			}
			const result = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ["videos"],
				allowsEditing: false,
			});
			if (result.canceled || !result.assets[0]) return;
			const asset = result.assets[0];
			const name = asset.fileName ?? `Cap Upload ${Date.now()}.mov`;
			endUploadSource();
			await uploadFile({
				uri: asset.uri,
				name,
				type: contentTypeForUpload(name, asset.mimeType),
				size: asset.fileSize,
				durationSeconds:
					typeof asset.duration === "number" && asset.duration > 0
						? asset.duration / 1000
						: undefined,
				width: asset.width > 0 ? asset.width : undefined,
				height: asset.height > 0 ? asset.height : undefined,
			});
		} catch (error) {
			setSourceError({
				message: getUploadSourceErrorMessage(error, "photos"),
				source: "photos",
			});
		} finally {
			endUploadSource();
		}
	};

	const retry = async (item: UploadQueueItem) => {
		if (activeIdRef.current !== null) return;
		dispatch({ type: "retry", id: item.id });
		await uploadQueueItem(item, {
			uri: item.localUri,
			name: item.fileName,
			type: item.contentType,
			size: item.size,
			durationSeconds: item.durationSeconds,
			width: item.width,
			height: item.height,
		});
	};

	const viewCap = (capId: string | null) => {
		if (activeIdRef.current !== null) return;
		if (!capId) return;
		router.push(`/caps/${capId}`);
	};

	const removeQueueItem = (item: UploadQueueItem) => {
		if (activeIdRef.current !== null) return;
		dispatch({ type: "remove", id: item.id });
	};

	const showQueueItemActions = (item: UploadQueueItem) => {
		if (activeIdRef.current !== null) return;
		const actions: Array<{
			label: string;
			destructive?: boolean;
			onPress: () => void;
		}> = [];

		if (item.status === "failed") {
			actions.push({
				label: "Retry",
				onPress: () => {
					void retry(item);
				},
			});
		}

		if (
			(item.status === "processing" || item.status === "complete") &&
			item.capId
		) {
			actions.push({
				label: "View",
				onPress: () => viewCap(item.capId),
			});
		}

		actions.push({
			label: "Remove from Queue",
			destructive: true,
			onPress: () => removeQueueItem(item),
		});

		if (Platform.OS === "ios") {
			const cancelButtonIndex = actions.length;
			const destructiveButtonIndex = actions.findIndex(
				(action) => action.destructive,
			);
			ActionSheetIOS.showActionSheetWithOptions(
				{
					cancelButtonIndex,
					destructiveButtonIndex:
						destructiveButtonIndex >= 0 ? destructiveButtonIndex : undefined,
					message: uploadQueueMetadataText(item),
					options: [...actions.map((action) => action.label), "Cancel"],
					title: item.fileName,
					tintColor: colors.blue11,
					userInterfaceStyle: "light",
				},
				(index) => {
					actions[index]?.onPress();
				},
			);
			return;
		}

		Alert.alert(item.fileName, uploadQueueMetadataText(item), [
			...actions.map((action) => ({
				text: action.label,
				style: action.destructive ? ("destructive" as const) : undefined,
				onPress: action.onPress,
			})),
			{ text: "Cancel", style: "cancel" },
		]);
	};

	const showUploadSources = () => {
		if (isUploadSourceBusy()) return;

		if (Platform.OS === "ios") {
			ActionSheetIOS.showActionSheetWithOptions(
				{
					options: ["Browse Files", "Photos", idleLoomImportLabel, "Cancel"],
					cancelButtonIndex: 3,
					message: uploadAcceptedFormats,
					title: "Upload File",
					tintColor: colors.blue11,
					userInterfaceStyle: "light",
				},
				(index) => {
					if (index === 0) void pickFile();
					if (index === 1) void pickPhoto();
					if (index === 2) void openLoomImport();
				},
			);
			return;
		}

		Alert.alert("Upload File", "Choose a video source.", [
			{ text: "Browse Files", onPress: () => void pickFile() },
			{ text: "Photos", onPress: () => void pickPhoto() },
			{ text: idleLoomImportLabel, onPress: () => void openLoomImport() },
			{ text: "Cancel", style: "cancel" },
		]);
	};

	const openLoomImport = async () => {
		if (!beginUploadSource("loom")) return;

		try {
			const url = new URL("/dashboard/import/loom", apiBaseUrl);
			await WebBrowser.openBrowserAsync(url.toString());
		} catch (error) {
			setSourceError({
				message: getUploadSourceErrorMessage(error, "loom"),
				source: "loom",
			});
		} finally {
			endUploadSource();
		}
	};

	if (auth.status === "loading") {
		return <Screen title="Import" loading />;
	}

	if (auth.status === "signedOut") {
		return (
			<Screen scroll>
				<SignInPanel title="Sign in to import" />
			</Screen>
		);
	}

	return (
		<Screen
			title="Import"
			subtitle="Import videos from external sources or upload from your device."
			scroll
		>
			<GlassSurface
				fallbackStyle={styles.importCardFallback}
				isInteractive
				style={styles.importCard}
				tintColor={colors.gray1}
			>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={uploadSourceAccessibilityLabel}
					accessibilityHint={
						sourcePending
							? sourceOpeningHint
							: activeId !== null
								? activeUploadHint
								: sourceLoading === "loom"
									? sourceOpeningHint
									: uploadSourceError
										? "Retries upload source options"
										: "Opens upload source options"
					}
					accessibilityState={{
						busy: uploadSourceBusy,
						disabled: uploadSourceBusy,
					}}
					accessibilityValue={uploadSourceAccessibilityValue}
					disabled={uploadSourceBusy}
					onPress={showUploadSources}
					style={({ pressed }) => [
						styles.importPressable,
						uploadSourceBusy && styles.importPressableDisabled,
						pressed && !uploadSourceBusy && styles.importPressablePressed,
					]}
				>
					<View style={styles.importPreview}>
						<View style={styles.importIcon}>
							{uploadSourceCardBusy ? (
								<ActivityIndicator color={colors.gray11} />
							) : uploadSourceError ? (
								<SymbolView
									name="exclamationmark.triangle"
									size={27}
									tintColor={colors.red9}
									weight="medium"
								/>
							) : (
								<SymbolView
									name="square.and.arrow.up"
									size={28}
									tintColor={colors.gray10}
									weight="semibold"
								/>
							)}
						</View>
					</View>
					<View style={styles.importBody}>
						<View style={styles.importCopy}>
							<Text style={styles.importTitle}>
								{uploadSourceError ? "Upload source unavailable" : importTitle}
							</Text>
							<Text
								accessibilityLiveRegion={
									uploadSourceError ? "polite" : undefined
								}
								accessibilityRole={uploadSourceError ? "alert" : undefined}
								style={[
									styles.importSubtitle,
									uploadSourceError && styles.importErrorSubtitle,
								]}
							>
								{importSubtitle}
							</Text>
							{showUploadFormats ? (
								<Text style={styles.importMeta}>{uploadAcceptedFormats}</Text>
							) : null}
							{activeProgress !== null ? (
								<View
									accessibilityLabel="Upload progress"
									accessibilityRole="progressbar"
									accessibilityValue={progressAccessibilityValue(
										activeProgress,
									)}
									style={styles.importProgressTrack}
								>
									<View
										style={[
											styles.importProgressFill,
											{ width: `${activeProgress}%` },
										]}
									/>
								</View>
							) : null}
						</View>
					</View>
				</Pressable>
				<View style={styles.actions}>
					<ActionButton
						label={browseFilesLabel}
						accessibilityValue={uploadSourceActionValue("files")}
						accessibilityHint={uploadSourceActionHint(
							"files",
							"Opens the native file picker",
						)}
						onPress={pickFile}
						loading={sourceLoading === "files"}
						disabled={uploadSourceBusy && sourceLoading !== "files"}
						style={styles.actionButton}
						size="sm"
						symbol="doc.badge.plus"
						variant="dark"
					/>
					<ActionButton
						label={photosLabel}
						accessibilityValue={uploadSourceActionValue("photos")}
						accessibilityHint={uploadSourceActionHint(
							"photos",
							"Opens your photo library",
						)}
						onPress={pickPhoto}
						variant="gray"
						loading={sourceLoading === "photos"}
						disabled={uploadSourceBusy && sourceLoading !== "photos"}
						style={styles.actionButton}
						size="sm"
						symbol="photo.on.rectangle.angled"
					/>
					<ActionButton
						label={loomActionLabel}
						accessibilityLabel={loomActionAccessibilityLabel ?? loomActionLabel}
						accessibilityValue={uploadSourceActionValue("loom")}
						accessibilityHint={uploadSourceActionHint(
							"loom",
							"Opens Loom import in a browser sheet",
						)}
						onPress={() => {
							void openLoomImport();
						}}
						variant="gray"
						loading={sourceLoading === "loom"}
						disabled={uploadSourceBusy && sourceLoading !== "loom"}
						style={styles.actionButton}
						size="sm"
						leading={<LoomMark />}
					/>
				</View>
			</GlassSurface>
			<GlassSurface
				fallbackStyle={styles.importCardFallback}
				isInteractive
				style={styles.importCard}
				tintColor={colors.gray1}
			>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={loomImportAccessibilityLabel}
					accessibilityHint={
						sourceLoading === "loom"
							? sourceOpeningHint
							: sourcePending
								? sourceOpeningHint
								: activeId !== null
									? activeUploadHint
									: loomImportError
										? "Retries Loom import"
										: "Opens Loom import in a browser sheet"
					}
					accessibilityState={{
						busy: uploadSourceBusy,
						disabled: uploadSourceBusy,
					}}
					accessibilityValue={loomImportAccessibilityValue}
					disabled={uploadSourceBusy}
					onPress={() => {
						void openLoomImport();
					}}
					style={({ pressed }) => [
						styles.importPressable,
						uploadSourceBusy && styles.importPressableDisabled,
						pressed && !uploadSourceBusy && styles.importPressablePressed,
					]}
				>
					<View style={styles.importPreview}>
						<View style={styles.importIcon}>
							{loomImportError ? (
								<SymbolView
									name="exclamationmark.triangle"
									size={27}
									tintColor={colors.red9}
									weight="medium"
								/>
							) : (
								<LoomMark />
							)}
						</View>
					</View>
					<View style={styles.importBody}>
						<View style={styles.importCopy}>
							<Text style={styles.importTitle}>{loomImportTitle}</Text>
							<Text
								accessibilityLiveRegion={loomImportError ? "polite" : undefined}
								accessibilityRole={loomImportError ? "alert" : undefined}
								style={[
									styles.importSubtitle,
									loomImportError && styles.importErrorSubtitle,
								]}
							>
								{loomImportSubtitle}
							</Text>
						</View>
					</View>
				</Pressable>
			</GlassSurface>
			<View style={styles.queue}>
				<Text style={styles.sectionTitle}>Queue</Text>
				{queue.items.length === 0 ? (
					<View style={styles.empty}>
						<SymbolView
							name="square.and.arrow.up"
							size={24}
							tintColor={colors.gray9}
							weight="medium"
						/>
						<Text style={styles.emptyText}>No uploads yet</Text>
					</View>
				) : (
					<GlassSurface
						fallbackStyle={styles.queueGroupFallback}
						isInteractive
						style={styles.queueGroup}
						tintColor={colors.gray1}
					>
						{queue.items
							.slice()
							.reverse()
							.map((item, index, items) => {
								const isActiveQueueItem = activeId === item.id;
								const queueActionsDisabled = activeId !== null;
								const queueProgress = uploadProgressPercent(item.progress);
								const showQueueProgress = uploadQueueHasProgress(item);
								const queueStatus = uploadQueueStatusText(item);
								const queueDisplayStatus =
									isActiveQueueItem && item.status === "queued"
										? "Preparing upload"
										: queueStatus;
								const queueMetadata = uploadQueueMetadataText(
									item,
									queueDisplayStatus,
								);
								const queueAccessibilityValue =
									queueActionsDisabled && activeUploadAccessibilityValue
										? activeUploadAccessibilityValue
										: { text: queueMetadata };
								const queueHint = isActiveQueueItem
									? item.status === "queued"
										? "Preparing upload"
										: "Upload is in progress"
									: queueActionsDisabled
										? "Another upload is in progress"
										: `${queueStatus}. Opens upload actions`;
								const queueMenuHint = queueActionsDisabled
									? queueHint
									: uploadQueueMenuHint(item);
								return (
									<View key={item.id}>
										<Pressable
											accessibilityRole="button"
											accessibilityLabel={`Upload ${item.fileName}`}
											accessibilityHint={queueHint}
											accessibilityState={{
												busy: isActiveQueueItem,
												disabled: queueActionsDisabled,
											}}
											accessibilityValue={queueAccessibilityValue}
											disabled={queueActionsDisabled}
											onLongPress={() => showQueueItemActions(item)}
											onPress={() => showQueueItemActions(item)}
											style={({ pressed }) => [
												styles.queueItem,
												queueActionsDisabled &&
													!isActiveQueueItem &&
													styles.queueItemDisabled,
												pressed && activeId === null && styles.queueItemPressed,
											]}
										>
											<View style={styles.queueText}>
												<Text numberOfLines={1} style={styles.fileName}>
													{item.fileName}
												</Text>
												<Text style={styles.fileMeta}>{queueMetadata}</Text>
												{showQueueProgress ? (
													<View
														accessibilityLabel={`Upload progress for ${item.fileName}`}
														accessibilityRole="progressbar"
														accessibilityValue={progressAccessibilityValue(
															queueProgress,
														)}
														style={styles.progressTrack}
													>
														<View
															style={[
																styles.progressFill,
																{
																	width: `${queueProgress}%`,
																},
															]}
														/>
													</View>
												) : null}
												{item.error ? (
													<Text
														accessibilityLiveRegion="polite"
														accessibilityRole="alert"
														numberOfLines={2}
														style={styles.errorText}
													>
														{item.error}
													</Text>
												) : null}
											</View>
											{item.status === "failed" ? (
												<ActionButton
													label="Retry"
													accessibilityLabel={`Retry upload ${item.fileName}`}
													accessibilityHint={
														queueActionsDisabled
															? "Another upload is in progress"
															: "Retries this upload"
													}
													accessibilityValue={
														queueActionsDisabled
															? activeUploadAccessibilityValue
															: undefined
													}
													onPress={(event) => {
														event?.stopPropagation();
														void retry(item);
													}}
													disabled={queueActionsDisabled}
													size="sm"
													style={styles.viewButton}
													symbol="arrow.clockwise"
													variant="secondary"
												/>
											) : (item.status === "processing" ||
													item.status === "complete") &&
												item.capId ? (
												<ActionButton
													label="View"
													accessibilityLabel={`View upload ${item.fileName}`}
													accessibilityHint={
														queueActionsDisabled
															? "Another upload is in progress"
															: "Opens the uploaded Cap"
													}
													accessibilityValue={
														queueActionsDisabled
															? activeUploadAccessibilityValue
															: undefined
													}
													onPress={(event) => {
														event?.stopPropagation();
														viewCap(item.capId);
													}}
													disabled={queueActionsDisabled}
													size="sm"
													style={styles.viewButton}
													symbol="play.rectangle"
													variant="secondary"
												/>
											) : null}
											<Pressable
												accessibilityRole="button"
												accessibilityLabel={`More actions for ${item.fileName}`}
												accessibilityHint={queueMenuHint}
												accessibilityState={{
													busy: isActiveQueueItem,
													disabled: queueActionsDisabled,
												}}
												accessibilityValue={
													queueActionsDisabled
														? activeUploadAccessibilityValue
														: undefined
												}
												disabled={queueActionsDisabled}
												hitSlop={6}
												onPress={(event) => {
													event.stopPropagation();
													if (queueActionsDisabled) return;
													showQueueItemActions(item);
												}}
												style={({ pressed }) => [
													styles.queueMenuButton,
													queueActionsDisabled &&
														styles.queueMenuButtonDisabled,
													pressed &&
														!queueActionsDisabled &&
														styles.queueMenuButtonPressed,
												]}
											>
												<SymbolView
													name="ellipsis"
													size={17}
													tintColor={
														queueActionsDisabled ? colors.gray9 : colors.gray12
													}
													weight="semibold"
												/>
											</Pressable>
										</Pressable>
										{index < items.length - 1 ? (
											<View style={styles.queueSeparator} />
										) : null}
									</View>
								);
							})}
					</GlassSurface>
				)}
			</View>
		</Screen>
	);
}

const styles = StyleSheet.create({
	importCard: {
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		overflow: "hidden",
		marginBottom: 20,
		...squircle,
	},
	importCardFallback: {
		backgroundColor: colors.gray1,
	},
	importPressable: {
		width: "100%",
	},
	importPressablePressed: {
		backgroundColor: colors.gray2,
	},
	importPressableDisabled: {
		opacity: 0.58,
	},
	importPreview: {
		height: 128,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.gray3,
	},
	importIcon: {
		width: 56,
		height: 56,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.gray1,
		...squircle,
	},
	importBody: {
		padding: 16,
	},
	importCopy: {
		gap: 4,
	},
	importTitle: {
		fontFamily: fonts.medium,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray12,
	},
	importSubtitle: {
		fontFamily: fonts.regular,
		fontSize: 12,
		lineHeight: 16,
		color: colors.gray10,
	},
	importMeta: {
		fontFamily: fonts.regular,
		fontSize: 12,
		lineHeight: 16,
		color: colors.gray9,
	},
	importErrorSubtitle: {
		color: colors.red9,
	},
	importProgressTrack: {
		height: 5,
		borderRadius: radius.full,
		backgroundColor: colors.gray4,
		overflow: "hidden",
		marginTop: 10,
		...squircle,
	},
	importProgressFill: {
		height: "100%",
		borderRadius: radius.full,
		backgroundColor: colors.buttonBlue,
	},
	actions: {
		flexDirection: "row",
		gap: 10,
		width: "100%",
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.gray3,
		padding: 12,
	},
	actionButton: {
		flex: 1,
	},
	queue: {
		gap: 10,
	},
	sectionTitle: {
		fontFamily: fonts.medium,
		fontSize: 18,
		color: colors.gray12,
	},
	empty: {
		height: 124,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		backgroundColor: colors.gray1,
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		...squircle,
	},
	emptyText: {
		fontFamily: fonts.medium,
		color: colors.gray10,
	},
	queueGroup: {
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		overflow: "hidden",
		...squircle,
	},
	queueGroupFallback: {
		backgroundColor: colors.gray1,
	},
	queueItem: {
		minHeight: 78,
		padding: 12,
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
	},
	queueItemPressed: {
		backgroundColor: colors.gray2,
	},
	queueItemDisabled: {
		opacity: 0.58,
	},
	queueSeparator: {
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.gray4,
		marginLeft: 12,
	},
	queueText: {
		flex: 1,
		minWidth: 0,
		gap: 3,
	},
	fileName: {
		fontFamily: fonts.medium,
		fontSize: 16,
		color: colors.gray12,
	},
	fileMeta: {
		fontFamily: fonts.regular,
		fontSize: 13,
		color: colors.gray10,
	},
	errorText: {
		fontFamily: fonts.regular,
		fontSize: 12,
		color: colors.red9,
	},
	viewButton: {
		width: 88,
	},
	queueMenuButton: {
		width: 42,
		height: 42,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.gray2,
		...squircle,
	},
	queueMenuButtonPressed: {
		backgroundColor: colors.gray4,
	},
	queueMenuButtonDisabled: {
		backgroundColor: colors.gray3,
	},
	progressTrack: {
		height: 4,
		borderRadius: radius.full,
		backgroundColor: colors.gray4,
		overflow: "hidden",
		marginTop: 5,
	},
	progressFill: {
		height: "100%",
		borderRadius: radius.full,
		backgroundColor: colors.buttonBlue,
	},
});

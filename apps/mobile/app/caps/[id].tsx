import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { type SFSymbol, SymbolView } from "expo-symbols";
import { useVideoPlayer, VideoView } from "expo-video";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ActionSheetIOS,
	ActivityIndicator,
	Alert,
	Linking,
	Platform,
	Pressable,
	Share,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import type { MobileCapDetail, MobilePlaybackResponse } from "@/api/mobile";
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
import { GlassSurface } from "@/components/GlassSurface";
import { Screen } from "@/components/Screen";
import { colors, fonts, radius, squircle } from "@/theme";
import { formatRelativeDate } from "@/utils/format";

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

const getCapDetailErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : "Unable to load this Cap";

const reactionOptions = ["😂", "😍", "😮", "🙌", "👍", "👎", "👏", "🔥"];

type CapDetailOperation = "comment" | "save" | "visibility";

type AnalyticsMetricProps = {
	symbol: SFSymbol;
	value: number;
};

function AnalyticsMetric({ symbol, value }: AnalyticsMetricProps) {
	return (
		<View style={styles.metric}>
			<SymbolView
				name={symbol}
				size={15}
				tintColor={colors.gray8}
				weight="medium"
			/>
			<Text style={styles.metricText}>{value}</Text>
		</View>
	);
}

export default function CapDetailScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const auth = useAuth();
	const [detail, setDetail] = useState<MobileCapDetail | null>(null);
	const [playback, setPlayback] = useState<MobilePlaybackResponse | null>(null);
	const [comment, setComment] = useState("");
	const [loading, setLoading] = useState(true);
	const [activeOperation, setActiveOperation] =
		useState<CapDetailOperation | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [saved, setSaved] = useState(false);
	const [settingsVisible, setSettingsVisible] = useState(false);
	const [playbackLoading, setPlaybackLoading] = useState(false);
	const [playbackError, setPlaybackError] = useState<string | null>(null);
	const player = useVideoPlayer(null);

	const load = useCallback(async () => {
		if (auth.status !== "signedIn" || typeof id !== "string") return;
		setLoading(true);
		setLoadError(null);
		try {
			const [nextDetail, nextPlayback] = await Promise.all([
				auth.client.getCap(id),
				auth.client.getPlayback(id),
			]);
			setDetail(nextDetail);
			setPlayback(nextPlayback);
		} catch (error) {
			setDetail(null);
			setPlayback(null);
			setLoadError(getCapDetailErrorMessage(error));
		} finally {
			setLoading(false);
		}
	}, [auth, id]);

	useEffect(() => {
		load().catch(() => {});
	}, [load]);

	useEffect(() => {
		if (!playback?.url) {
			setPlaybackLoading(false);
			setPlaybackError(null);
			return;
		}

		let active = true;
		setPlaybackLoading(true);
		setPlaybackError(null);
		player
			.replaceAsync({
				uri: playback.url,
				contentType: playback.kind === "hls" ? "hls" : "progressive",
			})
			.then(() => {
				if (active) setPlaybackLoading(false);
			})
			.catch((error: unknown) => {
				if (!active) return;
				setPlaybackLoading(false);
				setPlaybackError(getCapDetailErrorMessage(error));
			});

		return () => {
			active = false;
		};
	}, [playback, player]);

	useEffect(() => {
		if (!copied) return;
		const timeout = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timeout);
	}, [copied]);

	useEffect(() => {
		if (!saved) return;
		const timeout = setTimeout(() => setSaved(false), 1600);
		return () => clearTimeout(timeout);
	}, [saved]);

	const textComments = useMemo(
		() => detail?.comments.filter((item) => item.type === "text") ?? [],
		[detail],
	);
	const reactions = useMemo(
		() => detail?.comments.filter((item) => item.type === "emoji") ?? [],
		[detail],
	);
	const isActionInProgress = activeOperation !== null;
	const isPostingComment = activeOperation === "comment";
	const isSavingVideo = activeOperation === "save";
	const isUpdatingVisibility = activeOperation === "visibility";
	const actionInProgressHint = "Current Cap action is in progress";
	const saveVideoLabel = saved ? "Saved" : "Save video";
	const saveVideoAccessibilityText =
		isSavingVideo && detail
			? `Saving video for ${detail.cap.title}`
			: saved && detail
				? `Saved video for ${detail.cap.title}`
				: undefined;
	const saveVideoAccessibilityLabel = saved
		? saveVideoAccessibilityText
		: undefined;
	const saveVideoAccessibilityValue =
		isSavingVideo && saveVideoAccessibilityText
			? { text: saveVideoAccessibilityText }
			: undefined;
	const saveVideoHint = isSavingVideo
		? "Save is in progress"
		: isActionInProgress
			? actionInProgressHint
			: "Saves this video to Photos";
	const sharingStatusHint = isUpdatingVisibility
		? "Sharing update is in progress"
		: isActionInProgress
			? actionInProgressHint
			: "Opens sharing settings";
	const sharingStatusLabel = detail?.cap.public ? "Shared" : "Not shared";
	const sharingStatusAccessibilityValue =
		isUpdatingVisibility && detail
			? `Updating sharing for ${detail.cap.title}`
			: undefined;
	const commentHint = isPostingComment
		? "Comment is being sent"
		: isActionInProgress
			? actionInProgressHint
			: "Add a comment to this Cap";
	const sendCommentHint = isPostingComment
		? "Comment is being sent"
		: isActionInProgress
			? actionInProgressHint
			: comment.trim().length > 0
				? "Adds this comment"
				: "Enter a comment before sending";
	const sendCommentLabel = isPostingComment ? "Sending..." : "Send";
	const sendCommentAccessibilityLabel =
		isPostingComment && detail
			? `Sending comment on ${detail.cap.title}`
			: "Send comment";
	const canSendComment = comment.trim().length > 0 && !isActionInProgress;

	const createComment = async () => {
		const trimmed = comment.trim();
		if (!trimmed || !detail || isActionInProgress) return;
		setActiveOperation("comment");
		try {
			const created = await auth.client.createComment(detail.cap.id, {
				content: trimmed,
				timestamp: null,
			});
			setDetail((current) =>
				current
					? {
							...current,
							comments: [...current.comments, created],
							cap: {
								...current.cap,
								commentCount: current.cap.commentCount + 1,
							},
						}
					: current,
			);
			setComment("");
		} catch (error) {
			Alert.alert(
				"Comment failed",
				error instanceof Error ? error.message : "Unable to add that comment.",
			);
		} finally {
			setActiveOperation(null);
		}
	};

	const createReaction = async (emoji: string) => {
		if (!detail) return;
		try {
			const created = await auth.client.createReaction(detail.cap.id, {
				content: emoji,
				timestamp: null,
			});
			setDetail((current) =>
				current
					? {
							...current,
							comments: [...current.comments, created],
							cap: {
								...current.cap,
								reactionCount: current.cap.reactionCount + 1,
							},
						}
					: current,
			);
		} catch (error) {
			Alert.alert(
				"Reaction failed",
				error instanceof Error ? error.message : "Unable to add that reaction.",
			);
		}
	};

	const copyLink = async () => {
		if (!detail) return;
		try {
			await Clipboard.setStringAsync(detail.shareUrl);
			setCopied(true);
		} catch (error) {
			Alert.alert(
				"Copy failed",
				error instanceof Error ? error.message : "Unable to copy this link.",
			);
		}
	};

	const shareLink = async () => {
		if (!detail) return;
		await Share.share({ url: detail.shareUrl, message: detail.shareUrl });
	};

	const updateVisibility = async (isPublic: boolean) => {
		if (!detail || isActionInProgress) return;
		setActiveOperation("visibility");
		try {
			const cap = await auth.client.updateCapSharing(detail.cap.id, {
				public: isPublic,
			});
			setDetail((current) => (current ? { ...current, cap } : current));
			await auth.refresh();
		} catch (error) {
			Alert.alert(
				"Sharing update failed",
				error instanceof Error
					? error.message
					: "Unable to update sharing for this Cap.",
			);
		} finally {
			setActiveOperation(null);
		}
	};

	const showPasswordActions = () => {
		if (!detail || auth.status !== "signedIn") return;
		showCapPasswordActions({
			cap: detail.cap,
			client: auth.client,
			onUpdated: async (cap) => {
				setDetail((current) => (current ? { ...current, cap } : current));
				await auth.refresh();
			},
		});
	};

	const showTitleActions = () => {
		if (!detail || auth.status !== "signedIn") return;
		showCapTitleActions({
			cap: detail.cap,
			client: auth.client,
			onUpdated: async (cap) => {
				setDetail((current) => (current ? { ...current, cap } : current));
				await auth.refresh();
			},
		});
	};

	const downloadVideo = async () => {
		if (!detail || isActionInProgress) return;
		setActiveOperation("save");
		try {
			await saveCapVideoToPhotos(auth.client, detail.cap.id);
			setSaved(true);
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
			setActiveOperation(null);
		}
	};

	const deleteCap = () => {
		if (!detail || isActionInProgress) return;
		const confirmDelete = () => {
			void (async () => {
				setSettingsVisible(false);
				await auth.client.deleteCap(detail.cap.id);
				await auth.refresh();
				router.back();
			})();
		};

		if (Platform.OS === "ios") {
			ActionSheetIOS.showActionSheetWithOptions(
				{
					cancelButtonIndex: 1,
					destructiveButtonIndex: 0,
					message: "This Cap will be removed from your library.",
					options: ["Delete Cap", "Cancel"],
					title: "Delete Cap",
					tintColor: colors.blue11,
					userInterfaceStyle: "light",
				},
				(index) => {
					if (index === 0) confirmDelete();
				},
			);
			return;
		}

		Alert.alert("Delete Cap", "This Cap will be removed from your library.", [
			{ text: "Cancel", style: "cancel" },
			{
				text: "Delete",
				style: "destructive",
				onPress: confirmDelete,
			},
		]);
	};

	const showMoreActions = () => {
		setSettingsVisible(true);
	};

	const viewAnalytics = () => {
		if (!detail || isActionInProgress) return;
		const url = new URL("/dashboard/analytics", apiBaseUrl);
		url.searchParams.set("capId", detail.cap.id);
		void WebBrowser.openBrowserAsync(url.toString());
	};

	if (auth.status === "signedOut") {
		return (
			<Screen scroll>
				<SignInPanel title="Sign in to view" />
			</Screen>
		);
	}

	return (
		<View style={styles.container}>
			<Stack.Screen
				options={{
					headerShown: true,
					headerTransparent: true,
					headerBlurEffect: "systemThinMaterialLight",
					headerShadowVisible: false,
					headerStyle: { backgroundColor: colors.glass },
					headerTintColor: colors.gray12,
					headerTitleStyle: { fontFamily: fonts.medium },
					headerRight: () =>
						detail ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="More actions"
								accessibilityHint={
									isActionInProgress
										? actionInProgressHint
										: "Opens Cap settings"
								}
								accessibilityState={{ disabled: isActionInProgress }}
								disabled={isActionInProgress}
								hitSlop={10}
								onPress={showMoreActions}
								style={({ pressed }) => [
									styles.headerAction,
									pressed && !isActionInProgress
										? styles.headerActionPressed
										: null,
									isActionInProgress ? styles.headerActionDisabled : null,
								]}
							>
								<SymbolView
									name="ellipsis.circle"
									size={22}
									tintColor={isActionInProgress ? colors.gray9 : colors.gray12}
									weight="medium"
								/>
							</Pressable>
						) : null,
					title: detail?.cap.title ?? "Cap",
				}}
			/>
			<Screen
				automaticallyAdjustKeyboardInsets
				loading={loading}
				scroll
				safeEdges={["left", "right"]}
			>
				{loadError ? (
					<View
						accessibilityLabel={`Cap detail error: ${loadError}`}
						accessibilityLiveRegion="polite"
						accessibilityRole="alert"
						style={styles.errorCard}
					>
						<SymbolView
							name="exclamationmark.triangle"
							size={26}
							tintColor={colors.red9}
							weight="medium"
						/>
						<Text style={styles.errorTitle}>Unable to load Cap</Text>
						<Text style={styles.errorBody}>{loadError}</Text>
						<ActionButton
							label="Try again"
							accessibilityHint="Reloads this Cap"
							onPress={() => {
								void load();
							}}
							symbol="arrow.clockwise"
							style={styles.retryButton}
						/>
					</View>
				) : detail ? (
					<>
						<View style={styles.videoFrame}>
							{playback?.url ? (
								<>
									<VideoView
										allowsPictureInPicture
										contentFit="contain"
										fullscreenOptions={{ enable: true }}
										nativeControls
										player={player}
										style={styles.video}
									/>
									{playbackLoading ? (
										<View style={styles.videoLoadingOverlay}>
											{detail.cap.thumbnailUrl ? (
												<Image
													cachePolicy="memory-disk"
													contentFit="cover"
													source={{ uri: detail.cap.thumbnailUrl }}
													style={StyleSheet.absoluteFillObject}
												/>
											) : null}
											<View style={styles.videoLoadingIndicator}>
												<ActivityIndicator color={colors.white} />
											</View>
										</View>
									) : null}
									{playbackError ? (
										<View
											accessibilityRole="alert"
											style={styles.videoErrorOverlay}
										>
											<Text style={styles.videoErrorText}>
												Unable to play this video
											</Text>
											<ActionButton
												accessibilityHint="Reloads this video"
												label="Try again"
												onPress={() =>
													setPlayback((current) =>
														current ? { ...current } : current,
													)
												}
												symbol="arrow.clockwise"
												variant="secondary"
											/>
										</View>
									) : null}
								</>
							) : (
								<View style={styles.videoPlaceholder}>
									<Text style={styles.placeholderText}>Processing video</Text>
								</View>
							)}
						</View>
						<View style={styles.titleBlock}>
							<Text style={styles.title}>{detail.cap.title}</Text>
							<Text style={styles.meta}>
								{formatRelativeDate(detail.cap.createdAt)} ·{" "}
								{detail.cap.ownerName}
							</Text>
							<View style={styles.statusRow}>
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={`Change sharing for ${detail.cap.title}`}
									accessibilityHint={sharingStatusHint}
									accessibilityState={{ disabled: isActionInProgress }}
									accessibilityValue={
										isUpdatingVisibility
											? {
													text:
														sharingStatusAccessibilityValue ??
														sharingStatusLabel,
												}
											: undefined
									}
									disabled={isActionInProgress}
									hitSlop={6}
									onPress={() => setSettingsVisible(true)}
									style={({ pressed }) => [
										styles.shareStatusButton,
										pressed && !isActionInProgress
											? styles.shareStatusButtonPressed
											: null,
										isActionInProgress
											? styles.shareStatusButtonDisabled
											: null,
									]}
								>
									<SymbolView
										name={detail.cap.public ? "globe" : "lock.open"}
										size={14}
										tintColor={
											isActionInProgress ? colors.gray9 : colors.gray10
										}
										weight="medium"
									/>
									<Text
										style={[
											styles.shareStatusText,
											isActionInProgress
												? styles.shareStatusTextDisabled
												: null,
										]}
									>
										{sharingStatusLabel}
									</Text>
									<SymbolView
										name="chevron.down"
										size={10}
										tintColor={
											isActionInProgress ? colors.gray9 : colors.gray10
										}
										weight="semibold"
									/>
								</Pressable>
								{detail.cap.protected ? (
									<View style={styles.passwordPill}>
										<SymbolView
											name="lock.fill"
											size={12}
											tintColor={colors.gray10}
											weight="semibold"
										/>
										<Text style={styles.passwordPillText}>
											Password protected
										</Text>
									</View>
								) : null}
							</View>
						</View>
						<View style={styles.actions}>
							<ActionButton
								label={copied ? "Copied" : "Copy link"}
								accessibilityHint="Copies this Cap link"
								variant="secondary"
								onPress={copyLink}
								style={styles.actionButton}
								symbol={copied ? "checkmark" : "doc.on.doc"}
							/>
							<ActionButton
								label="Share"
								accessibilityHint="Opens the native share sheet"
								variant="secondary"
								onPress={shareLink}
								style={styles.actionButton}
								symbol="square.and.arrow.up"
							/>
							<ActionButton
								label={saveVideoLabel}
								accessibilityLabel={saveVideoAccessibilityLabel}
								accessibilityValue={saveVideoAccessibilityValue}
								accessibilityHint={saveVideoHint}
								variant="secondary"
								onPress={downloadVideo}
								disabled={isActionInProgress && !isSavingVideo}
								loading={isSavingVideo}
								style={styles.actionButton}
								symbol={saved ? "checkmark" : "square.and.arrow.down"}
							/>
						</View>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel={`View analytics for ${detail.cap.title}`}
							accessibilityHint="Opens analytics in a browser sheet"
							onPress={viewAnalytics}
							style={({ pressed }) => [
								styles.analyticsPanel,
								pressed && styles.analyticsPanelPressed,
							]}
						>
							<View style={styles.analyticsMetrics}>
								<AnalyticsMetric symbol="eye" value={detail.cap.viewCount} />
								<AnalyticsMetric
									symbol="text.bubble"
									value={detail.cap.commentCount}
								/>
								<AnalyticsMetric
									symbol="face.smiling"
									value={detail.cap.reactionCount}
								/>
							</View>
							<Text style={styles.analyticsLink}>View analytics</Text>
						</Pressable>
						{detail.summary ? (
							<GlassSurface
								fallbackStyle={styles.sectionFallback}
								isInteractive
								style={styles.section}
								tintColor={colors.gray1}
							>
								<Text style={styles.sectionTitle}>Summary</Text>
								<Text style={styles.bodyText}>{detail.summary}</Text>
							</GlassSurface>
						) : null}
						{detail.chapters.length > 0 ? (
							<GlassSurface
								fallbackStyle={styles.sectionFallback}
								isInteractive
								style={styles.section}
								tintColor={colors.gray1}
							>
								<Text style={styles.sectionTitle}>Chapters</Text>
								{detail.chapters.map((chapter) => (
									<View
										key={`${chapter.start}-${chapter.title}`}
										style={styles.chapter}
									>
										<Text style={styles.chapterTime}>
											{Math.floor(chapter.start / 60)}:
											{Math.floor(chapter.start % 60)
												.toString()
												.padStart(2, "0")}
										</Text>
										<Text numberOfLines={2} style={styles.chapterTitle}>
											{chapter.title}
										</Text>
									</View>
								))}
							</GlassSurface>
						) : null}
						<GlassSurface
							fallbackStyle={styles.sectionFallback}
							isInteractive
							style={styles.section}
							tintColor={colors.gray1}
						>
							<View style={styles.sectionHeader}>
								<Text style={styles.sectionTitle}>Reactions</Text>
								<Text style={styles.countText}>{reactions.length}</Text>
							</View>
							<View style={styles.reactions}>
								{reactionOptions.map((emoji) => (
									<ActionButton
										key={emoji}
										label={emoji}
										accessibilityLabel={`React with ${emoji}`}
										accessibilityHint="Adds this reaction"
										variant="secondary"
										onPress={() => createReaction(emoji)}
										style={styles.reactionButton}
									>
										{emoji}
									</ActionButton>
								))}
							</View>
						</GlassSurface>
						<GlassSurface
							fallbackStyle={styles.sectionFallback}
							isInteractive
							style={styles.section}
							tintColor={colors.gray1}
						>
							<View style={styles.sectionHeader}>
								<Text style={styles.sectionTitle}>Comments</Text>
								<Text style={styles.countText}>{textComments.length}</Text>
							</View>
							<View style={styles.commentInputRow}>
								<TextInput
									accessibilityHint={commentHint}
									accessibilityLabel="Comment"
									accessibilityState={{ disabled: isActionInProgress }}
									autoCapitalize="sentences"
									autoCorrect
									editable={!isActionInProgress}
									enablesReturnKeyAutomatically
									keyboardAppearance="light"
									onChangeText={setComment}
									onSubmitEditing={() => {
										void createComment();
									}}
									placeholder="Add a comment"
									placeholderTextColor={colors.gray9}
									returnKeyType="send"
									selectionColor={colors.blue11}
									style={[
										styles.commentInput,
										isActionInProgress ? styles.commentInputDisabled : null,
									]}
									submitBehavior="blurAndSubmit"
									value={comment}
									multiline
								/>
								<ActionButton
									label={sendCommentLabel}
									accessibilityLabel={sendCommentAccessibilityLabel}
									accessibilityHint={sendCommentHint}
									onPress={createComment}
									disabled={!canSendComment && !isPostingComment}
									loading={isPostingComment}
									style={styles.sendButton}
									symbol="paperplane.fill"
								/>
							</View>
							{textComments.map((item) => (
								<View key={item.id} style={styles.comment}>
									<View style={styles.commentIcon}>
										<SymbolView
											name="text.bubble"
											size={16}
											tintColor={colors.blue11}
											weight="medium"
										/>
									</View>
									<View style={styles.commentBody}>
										<Text numberOfLines={1} style={styles.commentAuthor}>
											{item.author.name ?? "Cap user"}
										</Text>
										<Text style={styles.commentText}>{item.content}</Text>
									</View>
								</View>
							))}
						</GlassSurface>
					</>
				) : null}
			</Screen>
			<CapSettingsSheet
				cap={detail?.cap ?? null}
				visible={settingsVisible && detail !== null}
				onClose={() => setSettingsVisible(false)}
				onCopyLink={() => {
					void copyLink();
				}}
				onDelete={() => deleteCap()}
				onPassword={() => showPasswordActions()}
				onRename={() => showTitleActions()}
				onSaveVideo={() => {
					void downloadVideo();
				}}
				onShareLink={() => {
					void shareLink();
				}}
				onViewAnalytics={() => viewAnalytics()}
				onVisibilityChange={(_cap, isPublic) => {
					void updateVisibility(isPublic);
				}}
				saveDisabled={isActionInProgress}
				saveDisabledHint={saveVideoHint}
				saveDisabledValue={isSavingVideo ? undefined : "Unavailable"}
				saveDisabledAccessibilityValue={
					isSavingVideo ? saveVideoAccessibilityText : undefined
				}
				visibilityDisabled={isActionInProgress}
				visibilityDisabledHint={sharingStatusHint}
				visibilityDisabledAccessibilityValue={sharingStatusAccessibilityValue}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	headerAction: {
		width: 36,
		height: 36,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
	},
	headerActionPressed: {
		backgroundColor: colors.gray3,
	},
	headerActionDisabled: {
		opacity: 0.55,
	},
	videoFrame: {
		width: "100%",
		aspectRatio: 16 / 9,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		overflow: "hidden",
		backgroundColor: colors.black,
		marginBottom: 14,
		...squircle,
	},
	video: {
		width: "100%",
		height: "100%",
	},
	videoLoadingOverlay: {
		...StyleSheet.absoluteFillObject,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.black,
	},
	videoLoadingIndicator: {
		width: 44,
		height: 44,
		borderRadius: radius.full,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(0, 0, 0, 0.62)",
	},
	videoErrorOverlay: {
		...StyleSheet.absoluteFillObject,
		alignItems: "center",
		justifyContent: "center",
		gap: 10,
		backgroundColor: "rgba(0, 0, 0, 0.86)",
		padding: 16,
	},
	videoErrorText: {
		fontFamily: fonts.medium,
		fontSize: 15,
		color: colors.white,
	},
	videoPlaceholder: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
	},
	placeholderText: {
		fontFamily: fonts.medium,
		color: colors.gray10,
	},
	titleBlock: {
		gap: 4,
		marginBottom: 14,
	},
	title: {
		fontFamily: fonts.medium,
		fontSize: 24,
		lineHeight: 30,
		color: colors.gray12,
	},
	meta: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray10,
	},
	statusRow: {
		flexDirection: "row",
		alignItems: "center",
		flexWrap: "wrap",
		gap: 8,
		marginTop: 4,
	},
	shareStatusButton: {
		minHeight: 30,
		maxWidth: "100%",
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		borderRadius: radius.full,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		backgroundColor: colors.gray1,
		paddingHorizontal: 11,
		...squircle,
	},
	shareStatusButtonPressed: {
		backgroundColor: colors.gray3,
		borderColor: colors.gray5,
	},
	shareStatusButtonDisabled: {
		backgroundColor: colors.gray2,
		borderColor: colors.gray3,
	},
	shareStatusText: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 19,
		color: colors.gray10,
	},
	shareStatusTextDisabled: {
		color: colors.gray9,
	},
	passwordPill: {
		minHeight: 30,
		maxWidth: "100%",
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		borderRadius: radius.full,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		backgroundColor: colors.gray1,
		paddingHorizontal: 11,
		...squircle,
	},
	passwordPillText: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 19,
		color: colors.gray10,
	},
	actions: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
		marginBottom: 18,
	},
	actionButton: {
		flexBasis: 112,
		flexGrow: 1,
	},
	analyticsPanel: {
		minHeight: 42,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		backgroundColor: colors.gray1,
		paddingHorizontal: 14,
		paddingVertical: 10,
		marginBottom: 20,
		...squircle,
	},
	analyticsPanelPressed: {
		backgroundColor: colors.gray2,
		borderColor: colors.blue10,
	},
	analyticsMetrics: {
		flexDirection: "row",
		alignItems: "center",
		flexWrap: "wrap",
		gap: 16,
		flexShrink: 1,
	},
	metric: {
		flexDirection: "row",
		alignItems: "center",
		gap: 7,
	},
	metricText: {
		fontFamily: fonts.regular,
		fontSize: 14,
		color: colors.gray12,
	},
	analyticsLink: {
		fontFamily: fonts.regular,
		fontSize: 12,
		lineHeight: 17,
		color: colors.blue11,
	},
	errorCard: {
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		backgroundColor: colors.gray1,
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 18,
		paddingVertical: 24,
		...squircle,
	},
	errorTitle: {
		fontFamily: fonts.medium,
		fontSize: 19,
		color: colors.gray12,
		textAlign: "center",
	},
	errorBody: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray10,
		textAlign: "center",
	},
	retryButton: {
		marginTop: 4,
		minWidth: 150,
	},
	section: {
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		gap: 10,
		padding: 16,
		marginBottom: 20,
		...squircle,
	},
	sectionFallback: {
		backgroundColor: colors.gray1,
	},
	sectionHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	sectionTitle: {
		fontFamily: fonts.medium,
		fontSize: 18,
		lineHeight: 23,
		color: colors.gray12,
	},
	countText: {
		fontFamily: fonts.medium,
		fontSize: 14,
		color: colors.gray10,
	},
	bodyText: {
		fontFamily: fonts.regular,
		fontSize: 15,
		lineHeight: 23,
		color: colors.gray11,
	},
	chapter: {
		minHeight: 48,
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		borderRadius: radius.sm,
		backgroundColor: colors.gray2,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		padding: 10,
		...squircle,
	},
	chapterTime: {
		width: 44,
		fontFamily: fonts.medium,
		fontSize: 13,
		color: colors.blue11,
	},
	chapterTitle: {
		flex: 1,
		fontFamily: fonts.medium,
		fontSize: 14,
		color: colors.gray12,
	},
	reactions: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
	},
	reactionButton: {
		flexBasis: "21%",
		flexGrow: 1,
		maxWidth: 80,
	},
	commentInputRow: {
		flexDirection: "row",
		alignItems: "flex-end",
		gap: 8,
	},
	commentInput: {
		flex: 1,
		minHeight: 46,
		maxHeight: 120,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray4,
		backgroundColor: colors.gray2,
		paddingHorizontal: 12,
		paddingVertical: 10,
		fontFamily: fonts.regular,
		fontSize: 15,
		color: colors.gray12,
		...squircle,
	},
	commentInputDisabled: {
		backgroundColor: colors.gray3,
		color: colors.gray10,
	},
	sendButton: {
		width: 92,
	},
	comment: {
		flexDirection: "row",
		gap: 10,
		backgroundColor: colors.gray2,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		padding: 12,
		...squircle,
	},
	commentIcon: {
		width: 30,
		height: 30,
		borderRadius: radius.sm,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.blue3,
		...squircle,
	},
	commentBody: {
		flex: 1,
		minWidth: 0,
		gap: 3,
	},
	commentAuthor: {
		fontFamily: fonts.medium,
		fontSize: 14,
		color: colors.gray12,
	},
	commentText: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray11,
	},
});

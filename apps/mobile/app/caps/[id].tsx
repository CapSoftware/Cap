import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { type SFSymbol, SymbolView } from "expo-symbols";
import { useVideoPlayer, VideoView } from "expo-video";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import Animated, {
	FadeInDown,
	useAnimatedStyle,
	useSharedValue,
	withSpring,
	withTiming,
} from "react-native-reanimated";
import type {
	MobileCapDetail,
	MobileContentReportReason,
	MobilePlaybackResponse,
} from "@/api/mobile";
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
import { Avatar } from "@/components/Avatar";
import { CircleIconButton } from "@/components/CircleIconButton";
import { GlassSurface } from "@/components/GlassSurface";
import { ReactionBar, type ReactionCount } from "@/components/ReactionBar";
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
const reportReasons: ReadonlyArray<{
	label: string;
	value: MobileContentReportReason;
}> = [
	{ label: "Harassment or bullying", value: "harassment" },
	{ label: "Hate speech", value: "hate" },
	{ label: "Sexual content", value: "sexual" },
	{ label: "Violence or threats", value: "violence" },
	{ label: "Copyright infringement", value: "copyright" },
	{ label: "Other concern", value: "other" },
];

const commentPageSize = 24;
const animatedCommentCount = 12;

const sectionEntrance = (order: number) =>
	FadeInDown.springify()
		.damping(18)
		.stiffness(220)
		.delay(order * 55);

const formatChapterTime = (start: number) => {
	const minutes = Math.floor(start / 60);
	const seconds = Math.floor(start % 60)
		.toString()
		.padStart(2, "0");
	return `${minutes}:${seconds}`;
};

type CapDetailOperation = "comment" | "safety" | "save" | "visibility";

type AnalyticsMetricProps = {
	symbol: SFSymbol;
	value: number;
};

function AnalyticsMetric({ symbol, value }: AnalyticsMetricProps) {
	const progress = useSharedValue(0);

	useEffect(() => {
		progress.value = withTiming(1, { duration: 320 });
	}, [progress]);

	const animatedStyle = useAnimatedStyle(() => ({
		opacity: progress.value,
		transform: [{ scale: 0.7 + progress.value * 0.3 }],
	}));

	return (
		<Animated.View style={[styles.metric, animatedStyle]}>
			<SymbolView
				name={symbol}
				size={15}
				tintColor={colors.gray8}
				weight="medium"
			/>
			<Text style={styles.metricText}>{value}</Text>
		</Animated.View>
	);
}

type PlayButtonProps = {
	accessibilityHint: string;
	accessibilityLabel: string;
	onPress: () => void;
};

function PlayButton({
	accessibilityHint,
	accessibilityLabel,
	onPress,
}: PlayButtonProps) {
	const scale = useSharedValue(1);

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [{ scale: scale.value }],
	}));

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityHint={accessibilityHint}
			accessibilityLabel={accessibilityLabel}
			hitSlop={16}
			onPress={onPress}
			onPressIn={() => {
				scale.value = withSpring(0.92, {
					damping: 18,
					mass: 0.7,
					stiffness: 320,
				});
			}}
			onPressOut={() => {
				scale.value = withSpring(1, { damping: 18, mass: 0.7, stiffness: 320 });
			}}
		>
			<Animated.View style={[styles.playButton, animatedStyle]}>
				<GlassSurface
					fallbackStyle={styles.playButtonFallback}
					glassEffectStyle="clear"
					isInteractive
					style={styles.playButtonGlass}
					tintColor="rgba(255, 255, 255, 0.28)"
				>
					<SymbolView
						name="play.fill"
						size={28}
						tintColor={colors.white}
						weight="semibold"
					/>
				</GlassSurface>
			</Animated.View>
		</Pressable>
	);
}

type CommentComposerProps = {
	disabled: boolean;
	isPosting: boolean;
	onSubmit: (content: string) => Promise<boolean>;
	title: string;
};

const CommentComposer = memo(function CommentComposer({
	disabled,
	isPosting,
	onSubmit,
	title,
}: CommentComposerProps) {
	const [comment, setComment] = useState("");
	const trimmedComment = comment.trim();
	const commentHint = isPosting
		? "Comment is being sent"
		: disabled
			? "Current Cap action is in progress"
			: "Add a comment to this Cap";
	const sendCommentHint = isPosting
		? "Comment is being sent"
		: disabled
			? "Current Cap action is in progress"
			: trimmedComment
				? "Adds this comment"
				: "Enter a comment before sending";
	const sendCommentAccessibilityLabel = isPosting
		? `Sending comment on ${title}`
		: "Send comment";
	const canSendComment = Boolean(trimmedComment) && !disabled;

	const submit = useCallback(async () => {
		if (!trimmedComment || disabled) return;
		if (await onSubmit(trimmedComment)) setComment("");
	}, [disabled, onSubmit, trimmedComment]);

	return (
		<View style={styles.commentInputRow}>
			<TextInput
				accessibilityHint={commentHint}
				accessibilityLabel="Comment"
				accessibilityState={{ disabled }}
				autoCapitalize="sentences"
				autoCorrect
				editable={!disabled}
				enablesReturnKeyAutomatically
				keyboardAppearance="light"
				onChangeText={setComment}
				onSubmitEditing={() => {
					void submit();
				}}
				placeholder="Add a comment"
				placeholderTextColor={colors.gray9}
				returnKeyType="send"
				selectionColor={colors.blue11}
				style={[
					styles.commentInput,
					disabled ? styles.commentInputDisabled : null,
				]}
				submitBehavior="blurAndSubmit"
				value={comment}
				multiline
			/>
			<CircleIconButton
				accessibilityHint={sendCommentHint}
				accessibilityLabel={sendCommentAccessibilityLabel}
				disabled={!canSendComment && !isPosting}
				loading={isPosting}
				onPress={() => {
					void submit();
				}}
				size={46}
				symbol="paperplane.fill"
				tone="accent"
			/>
		</View>
	);
});

type CommentListProps = {
	comments: MobileCapDetail["comments"];
};

const CommentList = memo(function CommentList({ comments }: CommentListProps) {
	return comments.map((item, index) => (
		<Animated.View
			entering={
				index < animatedCommentCount
					? FadeInDown.springify()
							.damping(18)
							.stiffness(220)
							.delay(Math.min(index, 6) * 40)
					: undefined
			}
			key={item.id}
			style={styles.comment}
		>
			<Avatar
				imageUrl={item.author.imageUrl}
				name={item.author.name}
				size={34}
			/>
			<View style={styles.commentBody}>
				<View style={styles.commentMeta}>
					<Text numberOfLines={1} style={styles.commentAuthor}>
						{item.author.name ?? "Cap user"}
					</Text>
					<Text style={styles.commentDate}>
						{formatRelativeDate(item.createdAt)}
					</Text>
				</View>
				<Text style={styles.commentText}>{item.content}</Text>
			</View>
		</Animated.View>
	));
});

type CommentsSectionProps = {
	comments: MobileCapDetail["comments"];
	disabled: boolean;
	isPosting: boolean;
	onCreateComment: (content: string) => Promise<string | null>;
	title: string;
};

const CommentsSection = memo(function CommentsSection({
	comments,
	disabled,
	isPosting,
	onCreateComment,
	title,
}: CommentsSectionProps) {
	const [visibleCommentCount, setVisibleCommentCount] =
		useState(commentPageSize);
	const [pinnedCommentId, setPinnedCommentId] = useState<string | null>(null);
	const visibleComments = useMemo(() => {
		const leadingComments = comments.slice(0, visibleCommentCount);
		if (!pinnedCommentId) return leadingComments;
		const pinnedComment = comments.find((item) => item.id === pinnedCommentId);
		return pinnedComment &&
			!leadingComments.some((item) => item.id === pinnedCommentId)
			? [...leadingComments, pinnedComment]
			: leadingComments;
	}, [comments, pinnedCommentId, visibleCommentCount]);
	const hiddenCommentCount = comments.length - visibleComments.length;
	const nextCommentCount = Math.min(hiddenCommentCount, commentPageSize);
	const submitComment = useCallback(
		async (content: string) => {
			const createdId = await onCreateComment(content);
			if (!createdId) return false;
			setPinnedCommentId(createdId);
			return true;
		},
		[onCreateComment],
	);

	return (
		<GlassSurface
			fallbackStyle={styles.sectionFallback}
			isInteractive
			style={styles.section}
			tintColor={colors.gray1}
		>
			<View style={styles.sectionHeader}>
				<Text style={styles.sectionTitle}>Comments</Text>
				<Text style={styles.countText}>{comments.length}</Text>
			</View>
			<CommentComposer
				disabled={disabled}
				isPosting={isPosting}
				onSubmit={submitComment}
				title={title}
			/>
			<CommentList comments={visibleComments} />
			{hiddenCommentCount > 0 ? (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={`Show ${nextCommentCount} more comments`}
					accessibilityHint="Shows the next comments"
					onPress={() =>
						setVisibleCommentCount((count) =>
							Math.min(count + commentPageSize, comments.length),
						)
					}
					style={({ pressed }) => [
						styles.showAllComments,
						pressed ? styles.showAllCommentsPressed : null,
					]}
				>
					<Text style={styles.showAllCommentsText}>
						Show {nextCommentCount} more comments
					</Text>
				</Pressable>
			) : null}
		</GlassSurface>
	);
});

export default function CapDetailScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const auth = useAuth();
	const authStatus = auth.status;
	const apiClient = auth.client;
	const [detail, setDetail] = useState<MobileCapDetail | null>(null);
	const [playback, setPlayback] = useState<MobilePlaybackResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [activeOperation, setActiveOperation] =
		useState<CapDetailOperation | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [saved, setSaved] = useState(false);
	const [settingsVisible, setSettingsVisible] = useState(false);
	const [playbackLoading, setPlaybackLoading] = useState(false);
	const [playbackError, setPlaybackError] = useState<string | null>(null);
	const [hasPlayed, setHasPlayed] = useState(false);
	const player = useVideoPlayer(null);
	const videoRef = useRef<VideoView>(null);

	const load = useCallback(async () => {
		if (authStatus !== "signedIn" || typeof id !== "string") return;
		setLoading(true);
		setLoadError(null);
		setHasPlayed(false);
		try {
			const [nextDetail, nextPlayback] = await Promise.all([
				apiClient.getCap(id),
				apiClient.getPlayback(id),
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
	}, [apiClient, authStatus, id]);

	useEffect(() => {
		void load();
	}, [load]);

	const thumbnailUrl = detail?.cap.thumbnailUrl;
	const thumbnailCacheKey = detail?.cap.thumbnailCacheKey;
	const thumbnailCapId = detail?.cap.id;
	const thumbnailSource = useMemo(() => {
		if (!thumbnailUrl || !thumbnailCapId) return null;
		return {
			uri: thumbnailUrl,
			cacheKey: thumbnailCacheKey ?? `cap-thumbnail:${thumbnailCapId}`,
			headers: auth.apiKey
				? { Authorization: `Bearer ${auth.apiKey}` }
				: undefined,
		};
	}, [auth.apiKey, thumbnailCacheKey, thumbnailCapId, thumbnailUrl]);

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
		[detail?.comments],
	);
	const reactions = useMemo(
		() => detail?.comments.filter((item) => item.type === "emoji") ?? [],
		[detail?.comments],
	);
	const reactionCounts = useMemo<ReactionCount[]>(() => {
		const tally = new Map<string, number>();
		for (const item of reactions) {
			tally.set(item.content, (tally.get(item.content) ?? 0) + 1);
		}
		const ordered: ReactionCount[] = [];
		for (const emoji of reactionOptions) {
			const count = tally.get(emoji);
			if (count) {
				ordered.push({ emoji, count });
				tally.delete(emoji);
			}
		}
		for (const [emoji, count] of tally) {
			ordered.push({ emoji, count });
		}
		return ordered;
	}, [reactions]);

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
	const canManageCap = detail ? detail.cap.ownedByCurrentUser !== false : false;
	const sharingStatusAccessibilityValue =
		isUpdatingVisibility && detail
			? `Updating sharing for ${detail.cap.title}`
			: undefined;
	const capId = detail?.cap.id;

	const createComment = useCallback(
		async (content: string) => {
			if (!capId || isActionInProgress) return null;
			setActiveOperation("comment");
			try {
				const created = await apiClient.createComment(capId, {
					content,
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
				return created.id;
			} catch (error) {
				Alert.alert(
					"Comment failed",
					error instanceof Error
						? error.message
						: "Unable to add that comment.",
				);
				return null;
			} finally {
				setActiveOperation(null);
			}
		},
		[apiClient, capId, isActionInProgress],
	);

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
			void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
		if (!detail || !canManageCap || isActionInProgress) return;
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
		if (!detail || !canManageCap || auth.status !== "signedIn") return;
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
		if (!detail || !canManageCap || auth.status !== "signedIn") return;
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
		if (!detail || !canManageCap || isActionInProgress) return;
		setActiveOperation("save");
		try {
			await saveCapVideoToPhotos(auth.client, detail.cap.id);
			setSaved(true);
			void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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

	const playVideo = () => {
		if (!playback?.url) return;
		void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
		setHasPlayed(true);
		player.play();
		void videoRef.current?.enterFullscreen();
	};

	const seekToChapter = (start: number) => {
		void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
		setHasPlayed(true);
		player.currentTime = start;
		player.play();
	};

	const deleteCap = () => {
		if (!detail || !canManageCap || isActionInProgress) return;
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
		if (!canManageCap) return;
		setSettingsVisible(true);
	};

	const viewAnalytics = () => {
		if (!detail || !canManageCap || isActionInProgress) return;
		router.push({ pathname: "/analytics", params: { capId: detail.cap.id } });
	};

	const reportCap = async (reason: MobileContentReportReason) => {
		if (!detail || isActionInProgress) return;
		setActiveOperation("safety");
		try {
			await auth.client.reportCap(detail.cap.id, reason);
			Alert.alert(
				"Report received",
				"Cap Support will review this content promptly.",
			);
		} catch {
			Alert.alert(
				"Report failed",
				"Your report could not be submitted. Check your connection and try again.",
			);
		} finally {
			setActiveOperation(null);
		}
	};

	const blockCapOwner = async () => {
		const ownerId = detail?.cap.ownerId;
		if (
			!detail ||
			!ownerId ||
			detail.cap.ownedByCurrentUser !== false ||
			isActionInProgress
		) {
			return;
		}

		setActiveOperation("safety");
		try {
			await auth.client.blockUser(ownerId);
			await auth.refresh().catch(() => undefined);
			router.back();
			Alert.alert(
				"User blocked",
				"You and this user will no longer see each other’s Caps or comments in the mobile app.",
			);
		} catch {
			Alert.alert(
				"Block failed",
				"This user could not be blocked. Check your connection and try again.",
			);
		} finally {
			setActiveOperation(null);
		}
	};

	const showReportReasons = () => {
		ActionSheetIOS.showActionSheetWithOptions(
			{
				cancelButtonIndex: reportReasons.length,
				options: [...reportReasons.map((reason) => reason.label), "Cancel"],
				title: "Why are you reporting this Cap?",
				tintColor: colors.blue11,
				userInterfaceStyle: "light",
			},
			(index) => {
				const reason = reportReasons[index];
				if (reason) void reportCap(reason.value);
			},
		);
	};

	const confirmBlockOwner = () => {
		if (!detail || detail.cap.ownedByCurrentUser !== false) return;
		ActionSheetIOS.showActionSheetWithOptions(
			{
				cancelButtonIndex: 1,
				destructiveButtonIndex: 0,
				message:
					"You and this user will no longer see each other’s Caps or comments in the mobile app.",
				options: [`Block ${detail.cap.ownerName || "this user"}`, "Cancel"],
				title: "Block this user?",
				tintColor: colors.blue11,
				userInterfaceStyle: "light",
			},
			(index) => {
				if (index === 0) void blockCapOwner();
			},
		);
	};

	const showSafetyActions = () => {
		if (!detail || isActionInProgress) return;
		const canBlock =
			Boolean(detail.cap.ownerId) && detail.cap.ownedByCurrentUser === false;
		const options = canBlock
			? [
					"Report this Cap",
					`Block ${detail.cap.ownerName || "this user"}`,
					"Cancel",
				]
			: ["Report this Cap", "Cancel"];
		ActionSheetIOS.showActionSheetWithOptions(
			{
				cancelButtonIndex: options.length - 1,
				options,
				title: "Content safety",
				tintColor: colors.blue11,
				userInterfaceStyle: "light",
			},
			(index) => {
				if (index === 0) showReportReasons();
				if (canBlock && index === 1) confirmBlockOwner();
			},
		);
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
					headerBackButtonDisplayMode: "minimal",
					headerBlurEffect: "systemThinMaterialLight",
					headerShadowVisible: false,
					headerStyle: { backgroundColor: colors.glass },
					headerTintColor: colors.gray12,
					headerTitleStyle: { fontFamily: fonts.medium },
					headerRight: () =>
						detail && canManageCap ? (
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
						<Animated.View
							entering={sectionEntrance(0)}
							style={styles.videoCard}
						>
							{playback?.url ? (
								<>
									<VideoView
										allowsPictureInPicture
										contentFit="contain"
										fullscreenOptions={{ enable: true }}
										nativeControls
										player={player}
										ref={videoRef}
										style={styles.video}
									/>
									{playbackLoading ? (
										<View style={styles.videoLoadingOverlay}>
											{thumbnailSource ? (
												<Image
													cachePolicy="memory-disk"
													contentFit="cover"
													recyclingKey={detail.cap.id}
													source={thumbnailSource}
													style={StyleSheet.absoluteFillObject}
												/>
											) : null}
											<View style={styles.videoLoadingIndicator}>
												<ActivityIndicator color={colors.white} />
											</View>
										</View>
									) : null}
									{!hasPlayed && !playbackLoading && !playbackError ? (
										<View style={styles.posterOverlay}>
											{thumbnailSource ? (
												<Image
													cachePolicy="memory-disk"
													contentFit="cover"
													recyclingKey={detail.cap.id}
													source={thumbnailSource}
													style={StyleSheet.absoluteFillObject}
												/>
											) : null}
											<View pointerEvents="none" style={styles.posterScrim} />
											<PlayButton
												accessibilityHint="Plays this video in fullscreen"
												accessibilityLabel={`Play ${detail.cap.title}`}
												onPress={playVideo}
											/>
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
						</Animated.View>
						<Animated.View
							entering={sectionEntrance(1)}
							style={styles.titleBlock}
						>
							<Text style={styles.title}>{detail.cap.title}</Text>
							<View style={styles.ownerRow}>
								<Avatar name={detail.cap.ownerName} size={38} />
								<View style={styles.ownerText}>
									<Text numberOfLines={1} style={styles.ownerName}>
										{detail.cap.ownerName}
									</Text>
									<Text style={styles.ownerDate}>
										{formatRelativeDate(detail.cap.createdAt)}
									</Text>
								</View>
							</View>
							<View style={styles.statusRow}>
								{canManageCap ? (
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
								) : (
									<View style={styles.shareStatusButton}>
										<SymbolView
											name={detail.cap.public ? "globe" : "lock.open"}
											size={14}
											tintColor={colors.gray10}
											weight="medium"
										/>
										<Text style={styles.shareStatusText}>
											{sharingStatusLabel}
										</Text>
									</View>
								)}
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
						</Animated.View>
						<Animated.View entering={sectionEntrance(2)} style={styles.actions}>
							<CircleIconButton
								accessibilityHint="Copies this Cap link"
								accessibilityLabel={copied ? "Copied" : "Copy link"}
								active={copied}
								caption={copied ? "Copied" : "Copy link"}
								onPress={() => {
									void copyLink();
								}}
								symbol="doc.on.doc"
							/>
							<CircleIconButton
								accessibilityHint="Opens the native share sheet"
								accessibilityLabel="Share"
								caption="Share"
								onPress={() => {
									void shareLink();
								}}
								symbol="square.and.arrow.up"
							/>
							{canManageCap ? (
								<CircleIconButton
									accessibilityHint={saveVideoHint}
									accessibilityLabel={
										saveVideoAccessibilityLabel ?? saveVideoLabel
									}
									accessibilityValue={saveVideoAccessibilityValue}
									active={saved}
									caption={saveVideoLabel}
									disabled={isActionInProgress && !isSavingVideo}
									loading={isSavingVideo}
									onPress={() => {
										void downloadVideo();
									}}
									symbol="square.and.arrow.down"
								/>
							) : null}
						</Animated.View>
						<Animated.View entering={sectionEntrance(3)}>
							{canManageCap ? (
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={`View analytics for ${detail.cap.title}`}
									accessibilityHint="Opens native analytics"
									onPress={viewAnalytics}
									style={({ pressed }) => [
										styles.analyticsPanel,
										pressed && styles.analyticsPanelPressed,
									]}
								>
									<View style={styles.analyticsMetrics}>
										<AnalyticsMetric
											symbol="eye"
											value={detail.cap.viewCount}
										/>
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
							) : (
								<View style={styles.analyticsPanel}>
									<View style={styles.analyticsMetrics}>
										<AnalyticsMetric
											symbol="eye"
											value={detail.cap.viewCount}
										/>
										<AnalyticsMetric
											symbol="text.bubble"
											value={detail.cap.commentCount}
										/>
										<AnalyticsMetric
											symbol="face.smiling"
											value={detail.cap.reactionCount}
										/>
									</View>
								</View>
							)}
						</Animated.View>
						{detail.summary ? (
							<Animated.View entering={sectionEntrance(4)}>
								<GlassSurface
									fallbackStyle={styles.sectionFallback}
									isInteractive
									style={styles.section}
									tintColor={colors.gray1}
								>
									<Text style={styles.sectionTitle}>Summary</Text>
									<Text style={styles.bodyText}>{detail.summary}</Text>
								</GlassSurface>
							</Animated.View>
						) : null}
						{detail.chapters.length > 0 ? (
							<Animated.View entering={sectionEntrance(5)}>
								<GlassSurface
									fallbackStyle={styles.sectionFallback}
									isInteractive
									style={styles.section}
									tintColor={colors.gray1}
								>
									<Text style={styles.sectionTitle}>Chapters</Text>
									{detail.chapters.map((chapter) => (
										<Pressable
											accessibilityRole="button"
											accessibilityHint="Plays this chapter"
											accessibilityLabel={`Play chapter ${chapter.title}`}
											key={`${chapter.start}-${chapter.title}`}
											onPress={() => seekToChapter(chapter.start)}
											style={({ pressed }) => [
												styles.chapter,
												pressed ? styles.chapterPressed : null,
											]}
										>
											<Text style={styles.chapterTime}>
												{formatChapterTime(chapter.start)}
											</Text>
											<Text numberOfLines={2} style={styles.chapterTitle}>
												{chapter.title}
											</Text>
											<SymbolView
												name="play.circle.fill"
												size={20}
												tintColor={colors.blue11}
												weight="medium"
											/>
										</Pressable>
									))}
								</GlassSurface>
							</Animated.View>
						) : null}
						<Animated.View entering={sectionEntrance(6)}>
							<ReactionBar
								counts={reactionCounts}
								onReact={(emoji) => {
									void createReaction(emoji);
								}}
								options={reactionOptions}
								total={reactions.length}
							/>
						</Animated.View>
						<Animated.View entering={sectionEntrance(7)}>
							<CommentsSection
								key={detail.cap.id}
								comments={textComments}
								disabled={isActionInProgress}
								isPosting={isPostingComment}
								onCreateComment={createComment}
								title={detail.cap.title}
							/>
						</Animated.View>
						<Pressable
							accessibilityHint="Reports this Cap or blocks its owner"
							accessibilityLabel="Report or block content"
							accessibilityRole="button"
							accessibilityState={{ disabled: isActionInProgress }}
							disabled={isActionInProgress}
							onPress={showSafetyActions}
							style={({ pressed }) => [
								styles.safetyAction,
								pressed ? styles.safetyActionPressed : null,
							]}
						>
							<SymbolView
								name="exclamationmark.bubble"
								size={16}
								tintColor={colors.gray10}
								weight="medium"
							/>
							<Text style={styles.safetyActionText}>Report or block</Text>
						</Pressable>
					</>
				) : null}
			</Screen>
			<CapSettingsSheet
				cap={detail?.cap ?? null}
				visible={settingsVisible && detail !== null && canManageCap}
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
	videoCard: {
		width: "100%",
		aspectRatio: 16 / 9,
		borderRadius: radius.xl,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		overflow: "hidden",
		backgroundColor: colors.black,
		marginBottom: 18,
		shadowColor: colors.black,
		shadowOffset: { width: 0, height: 12 },
		shadowOpacity: 0.16,
		shadowRadius: 24,
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
	posterOverlay: {
		...StyleSheet.absoluteFillObject,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.black,
	},
	posterScrim: {
		...StyleSheet.absoluteFillObject,
		backgroundColor: "rgba(0, 0, 0, 0.18)",
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
	playButton: {
		width: 68,
		height: 68,
		borderRadius: radius.full,
		overflow: "hidden",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(255, 255, 255, 0.5)",
		...squircle,
	},
	playButtonGlass: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		paddingLeft: 4,
	},
	playButtonFallback: {
		backgroundColor: "rgba(0, 0, 0, 0.42)",
	},
	titleBlock: {
		gap: 14,
		marginBottom: 20,
	},
	title: {
		fontFamily: fonts.medium,
		fontSize: 28,
		lineHeight: 34,
		letterSpacing: -0.5,
		color: colors.gray12,
	},
	ownerRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
	},
	ownerText: {
		flex: 1,
		minWidth: 0,
		gap: 1,
	},
	ownerName: {
		fontFamily: fonts.medium,
		fontSize: 15,
		lineHeight: 20,
		color: colors.gray12,
	},
	ownerDate: {
		fontFamily: fonts.regular,
		fontSize: 13,
		lineHeight: 18,
		color: colors.gray10,
	},
	statusRow: {
		flexDirection: "row",
		alignItems: "center",
		flexWrap: "wrap",
		gap: 8,
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
		justifyContent: "space-around",
		gap: 8,
		marginBottom: 22,
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
	chapterPressed: {
		backgroundColor: colors.gray3,
		borderColor: colors.gray5,
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
	commentInputRow: {
		flexDirection: "row",
		alignItems: "flex-end",
		gap: 10,
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
	commentBody: {
		flex: 1,
		minWidth: 0,
		gap: 3,
	},
	commentMeta: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	commentAuthor: {
		flexShrink: 1,
		fontFamily: fonts.medium,
		fontSize: 14,
		color: colors.gray12,
	},
	commentDate: {
		fontFamily: fonts.regular,
		fontSize: 12,
		color: colors.gray9,
	},
	commentText: {
		fontFamily: fonts.regular,
		fontSize: 14,
		lineHeight: 20,
		color: colors.gray11,
	},
	safetyAction: {
		alignItems: "center",
		alignSelf: "center",
		flexDirection: "row",
		gap: 6,
		marginTop: 6,
		paddingHorizontal: 14,
		paddingVertical: 10,
	},
	safetyActionPressed: {
		opacity: 0.65,
	},
	safetyActionText: {
		color: colors.gray10,
		fontFamily: fonts.medium,
		fontSize: 13,
	},
	showAllComments: {
		minHeight: 42,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: radius.sm,
		backgroundColor: colors.gray2,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.gray3,
		...squircle,
	},
	showAllCommentsPressed: {
		backgroundColor: colors.gray3,
	},
	showAllCommentsText: {
		fontFamily: fonts.medium,
		fontSize: 14,
		color: colors.blue11,
	},
});

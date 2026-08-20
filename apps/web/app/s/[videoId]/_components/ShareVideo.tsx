import type { comments as commentsSchema } from "@cap/database/schema";
import { NODE_ENV } from "@cap/env";
import { Logo } from "@cap/ui";
import type { ImageUpload } from "@cap/web-domain";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import clsx from "clsx";
import { useLiveTranscript } from "hooks/use-live-transcript";
import { useTranscript } from "hooks/use-transcript";
import { CheckCircle2, Info, Loader2Icon } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { finalizeDesktopSegmentsRecording } from "@/actions/video/finalize-desktop-segments";
import { Tooltip } from "@/components/Tooltip";
import { isRetryableDesktopSegmentsFinalizationError } from "@/lib/desktop-segments-retryable-errors";
import type { VideoData } from "../types";
import { type CaptionLanguage, useCaptionContext } from "./CaptionContext";
import { scheduleReadyRefresh } from "./deferred-ready-refresh";
import {
	PreparingVideoOverlay,
	RecordingInProgressOverlay,
} from "./RecordingInProgress";
import { ShareableLinkLimitOverlay } from "./ShareableLinkLimitOverlay";
import {
	shouldDeferPlaybackSource,
	shouldReloadPlaybackAfterUploadCompletes,
	type UploadProgress,
} from "./upload-progress";
import { formatChaptersAsVTT } from "./utils/transcript-utils";

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
	authorName: string | null;
	authorImage: ImageUpload.ImageUrl | null;
};

// Code-split the two players: a given share page only ever renders one of
// them (the source type is fixed per video), and the HLS player carries
// hls.js, which MP4 (instant) recordings never need. SSR still renders the
// taken branch and preloads its chunk, so the used player pays nothing; the
// unused player's chunk is simply never fetched.
const CapVideoPlayer = dynamic(() =>
	import("./CapVideoPlayer").then((m) => m.CapVideoPlayer),
);
const HLSVideoPlayer = dynamic(() =>
	import("./HLSVideoPlayer").then((m) => m.HLSVideoPlayer),
);

// Both ride outside the first paint: the tracker only mounts mid-upload (its
// RPC client drags the Effect runtime along), and the upgrade modal — which
// carries the Rive animation runtime — mounts on the first upgrade prompt.
const UploadProgressTracker = dynamic(() => import("./UploadProgressTracker"), {
	ssr: false,
});
const importUpgradeModal = () =>
	import("@/components/UpgradeModal").then((m) => m.UpgradeModal);
const UpgradeModal = dynamic(importUpgradeModal, { ssr: false });

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

// Stable default: `= []` in the destructuring would mint a new array identity
// every render and re-run the chapters VTT effect below each time.
const NO_CHAPTERS: { title: string; start: number }[] = [];

export const ShareVideo = forwardRef<
	HTMLVideoElement,
	{
		data: VideoData & {
			hasActiveUpload?: boolean;
		};
		comments: MaybePromise<CommentWithAuthor[]>;
		chapters?: { title: string; start: number }[];
		areChaptersDisabled?: boolean;
		areCaptionsDisabled?: boolean;
		areCommentStampsDisabled?: boolean;
		areReactionStampsDisabled?: boolean;
		/** Timeline view scrubs on the deck below the video, not in it. */
		externalTimeline?: boolean;
		/** Deck row the player's control bar renders into while the timeline is up. */
		controlsPortalEl?: HTMLElement | null;
		aiGenerationStatus?: AiGenerationStatus | null;
		canRetryProcessing?: boolean;
		canFinalizeDesktopSegments?: boolean;
		showPlaybackStatusBadge?: boolean;
		isEditProcessing: boolean;
		recordingStopped?: boolean;
		defaultPlaybackSpeed?: number;
		viewerIsOwner?: boolean;
	}
>(
	(
		{
			data,
			comments,
			chapters = NO_CHAPTERS,
			areCaptionsDisabled,
			areChaptersDisabled,
			areCommentStampsDisabled,
			areReactionStampsDisabled,
			externalTimeline = false,
			controlsPortalEl = null,
			canRetryProcessing,
			canFinalizeDesktopSegments = false,
			showPlaybackStatusBadge = false,
			isEditProcessing,
			recordingStopped = false,
			defaultPlaybackSpeed,
			viewerIsOwner = false,
		},
		ref,
	) => {
		const videoRef = useRef<HTMLVideoElement | null>(null);
		useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement, []);
		const router = useRouter();
		const handleUploadComplete = useCallback(() => {
			router.refresh();
		}, [router]);

		const captionContext = useCaptionContext();

		const handleCaptionLanguageChange = (language: string) => {
			captionContext.setSelectedLanguage(language as CaptionLanguage);
		};

		const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
		// Latch, not open-state: once the modal has been requested it stays
		// mounted so closing still plays its exit animation.
		const [upgradeModalMounted, setUpgradeModalMounted] = useState(false);
		const openUpgradeModal = () => {
			setUpgradeModalMounted(true);
			setUpgradeModalOpen(true);
		};
		const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
		const [chaptersUrl, setChaptersUrl] = useState<string | null>(null);
		const [commentsData, setCommentsData] = useState<CommentWithAuthor[]>([]);
		const [userConfirmedStopped, setUserConfirmedStopped] =
			useState(recordingStopped);
		const [isConfirmingStopped, setIsConfirmingStopped] = useState(false);
		const [confirmStoppedError, setConfirmStoppedError] = useState<
			string | null
		>(null);
		const autoFinalizeAttemptedRef = useRef(false);
		const pendingReadyRefreshRef = useRef(false);
		// Mirrors what `useUploadProgress(id, enabled)` returned inline: null when
		// idle, "fetching" from the first enabled render. The hook itself now lives
		// in the lazily-mounted tracker so finished videos skip its Effect chunk.
		const trackUploadProgress =
			data.source.type === "desktopSegments" && (data.hasActiveUpload ?? false);
		const [segmentUploadProgress, setSegmentUploadProgress] =
			useState<UploadProgress | null>(
				trackUploadProgress ? { status: "fetching" } : null,
			);
		useEffect(() => {
			// Both directions of an enable/disable flip mirror the old inline hook:
			// tracking starting mid-session reads "fetching" immediately (the lazy
			// tracker hasn't mounted yet), and stopping reads null.
			setSegmentUploadProgress(
				trackUploadProgress ? { status: "fetching" } : null,
			);
		}, [trackUploadProgress]);

		const { data: transcriptContent, error: transcriptError } = useTranscript(
			data.id,
			data.transcriptionStatus,
		);

		// Captions straight from the in-progress live transcript, so the player
		// shows them during and right after recording instead of waiting for the
		// canonical transcript (which takes over seamlessly when it lands).
		const isLiveTranscriptEnabled =
			data.source.type === "desktopSegments" &&
			data.metadata?.liveTranscript != null &&
			(data.transcriptionStatus == null ||
				data.transcriptionStatus === "PROCESSING");
		const { data: liveTranscript } = useLiveTranscript(
			data.id,
			isLiveTranscriptEnabled,
		);
		const liveVttContent =
			liveTranscript?.kind === "ready" ? liveTranscript.content : null;

		// Handle comments data
		useEffect(() => {
			if (comments) {
				if (Array.isArray(comments)) {
					setCommentsData(comments);
				} else {
					comments.then(setCommentsData);
				}
			}
		}, [comments]);

		// Media comments live on the timeline view, not as over-player stamps.
		// Memoised so the player's comment markers keep a stable identity across
		// the frequent re-renders this component sees during playback.
		const stampComments = useMemo(
			() =>
				commentsData.flatMap((comment) =>
					comment.type === "text" || comment.type === "emoji"
						? [
								{
									id: comment.id,
									type: comment.type,
									timestamp: comment.timestamp,
									content: comment.content,
									authorName: comment.authorName,
									authorImage: comment.authorImage ?? undefined,
								},
							]
						: [],
				),
			[commentsData],
		);

		useEffect(() => {
			if (recordingStopped) {
				setUserConfirmedStopped(true);
			}
		}, [recordingStopped]);

		// Handle seek functionality
		const handleSeek = (time: number) => {
			if (videoRef.current) {
				videoRef.current.currentTime = time;
			}
		};

		useEffect(() => {
			if (transcriptContent) {
				captionContext.setOriginalVttContent(transcriptContent);
			} else if (transcriptError) {
				console.error(
					"[Transcript] Transcript error from React Query:",
					transcriptError.message,
				);
			}
		}, [
			transcriptContent,
			transcriptError,
			captionContext.setOriginalVttContent,
		]);

		useEffect(() => {
			const vttContent = captionContext.currentVttContent;

			if (captionContext.selectedLanguage === "off") {
				setSubtitleUrl((prev) => {
					if (prev) {
						URL.revokeObjectURL(prev);
					}
					return null;
				});
				return;
			}

			const effectiveVtt =
				data.transcriptionStatus === "COMPLETE" && vttContent
					? vttContent
					: // The live transcript only exists in the original language.
						captionContext.selectedLanguage === "original"
						? liveVttContent
						: null;

			if (effectiveVtt) {
				const blob = new Blob([effectiveVtt], { type: "text/vtt" });
				const newUrl = URL.createObjectURL(blob);
				setSubtitleUrl((prev) => {
					if (prev) {
						URL.revokeObjectURL(prev);
					}
					return newUrl;
				});

				return () => {
					URL.revokeObjectURL(newUrl);
				};
			}
			setSubtitleUrl((prev) => {
				if (prev) {
					URL.revokeObjectURL(prev);
				}
				return null;
			});
		}, [
			data.transcriptionStatus,
			captionContext.currentVttContent,
			captionContext.selectedLanguage,
			liveVttContent,
		]);

		useEffect(() => {
			if (chapters?.length > 0) {
				const vttContent = formatChaptersAsVTT(chapters);
				const blob = new Blob([vttContent], { type: "text/vtt" });
				const newUrl = URL.createObjectURL(blob);
				setChaptersUrl((prev) => {
					if (prev) {
						URL.revokeObjectURL(prev);
					}
					return newUrl;
				});

				return () => {
					URL.revokeObjectURL(newUrl);
				};
			}
			setChaptersUrl((prev) => {
				if (prev) {
					URL.revokeObjectURL(prev);
				}
				return null;
			});
		}, [chapters]);

		const isMp4Source =
			data.source.type === "desktopMP4" || data.source.type === "webMP4";
		const isSegmentsSource = data.source.type === "desktopSegments";
		const isOverShareLimit = data.ownerIsOverShareLimit === true;
		const previousSegmentUploadProgressRef = useRef(segmentUploadProgress);
		const isActivelyRecording =
			isSegmentsSource &&
			(data.hasActiveUpload ?? false) &&
			!userConfirmedStopped &&
			(segmentUploadProgress?.status === "fetching" ||
				segmentUploadProgress?.status === "uploading");

		const isProcessingInProgress =
			isSegmentsSource &&
			(data.hasActiveUpload ?? false) &&
			!userConfirmedStopped &&
			!isActivelyRecording &&
			shouldDeferPlaybackSource(segmentUploadProgress);
		const handleConfirmStopped = useCallback(async () => {
			if (
				!canFinalizeDesktopSegments ||
				data.source.type !== "desktopSegments" ||
				!data.hasActiveUpload
			) {
				setUserConfirmedStopped(true);
				return;
			}

			setIsConfirmingStopped(true);
			setConfirmStoppedError(null);

			try {
				await finalizeDesktopSegmentsRecording({ videoId: data.id });
				setUserConfirmedStopped(true);
				router.refresh();
			} catch (error) {
				setConfirmStoppedError(
					error instanceof Error
						? error.message
						: "Recording could not be finalized",
				);
			} finally {
				setIsConfirmingStopped(false);
			}
		}, [
			canFinalizeDesktopSegments,
			data.hasActiveUpload,
			data.id,
			data.source.type,
			router,
		]);
		const shouldAutoFinalizeFailedSegments =
			isSegmentsSource &&
			(data.hasActiveUpload ?? false) &&
			canFinalizeDesktopSegments &&
			!userConfirmedStopped &&
			segmentUploadProgress?.status === "error" &&
			isRetryableDesktopSegmentsFinalizationError(
				segmentUploadProgress.errorMessage,
			);
		useEffect(() => {
			if (
				!shouldAutoFinalizeFailedSegments ||
				autoFinalizeAttemptedRef.current ||
				isConfirmingStopped
			) {
				return;
			}

			autoFinalizeAttemptedRef.current = true;
			void handleConfirmStopped();
		}, [
			handleConfirmStopped,
			isConfirmingStopped,
			shouldAutoFinalizeFailedSegments,
		]);
		const showFinalizeRecordingControl =
			isSegmentsSource &&
			(data.hasActiveUpload ?? false) &&
			canFinalizeDesktopSegments &&
			!userConfirmedStopped &&
			segmentUploadProgress?.status === "failed";
		useEffect(() => {
			if (!isSegmentsSource || !data.hasActiveUpload || !userConfirmedStopped) {
				previousSegmentUploadProgressRef.current = segmentUploadProgress;
				return;
			}

			if (
				shouldReloadPlaybackAfterUploadCompletes(
					previousSegmentUploadProgressRef.current,
					segmentUploadProgress,
					{ includeFetching: true },
				) &&
				!pendingReadyRefreshRef.current
			) {
				// Deferred so the player swap never restarts playback mid-view.
				pendingReadyRefreshRef.current = true;
				scheduleReadyRefresh({
					video: videoRef.current,
					videoId: data.id,
					refresh: () => router.refresh(),
				});
			}

			previousSegmentUploadProgressRef.current = segmentUploadProgress;
		}, [
			data.hasActiveUpload,
			data.id,
			isSegmentsSource,
			router,
			segmentUploadProgress,
			userConfirmedStopped,
		]);

		// After the deferred ready-refresh swaps the live HLS player for the MP4
		// player, resume where the viewer left off instead of restarting.
		useEffect(() => {
			if (!isMp4Source) return;
			let raw: string | null = null;
			try {
				raw = sessionStorage.getItem(`cap-playback-resume:${data.id}`);
				if (raw) sessionStorage.removeItem(`cap-playback-resume:${data.id}`);
			} catch {}
			if (!raw) return;

			let resumeAt = 0;
			try {
				const parsed = JSON.parse(raw) as { t?: number; savedAt?: number };
				if (
					typeof parsed.t === "number" &&
					Number.isFinite(parsed.t) &&
					Date.now() - (parsed.savedAt ?? 0) < 10 * 60 * 1000
				) {
					resumeAt = parsed.t;
				}
			} catch {}
			if (resumeAt <= 0) return;

			const trySeek = () => {
				const video = videoRef.current;
				if (video && video.readyState >= 1) {
					video.currentTime = Number.isFinite(video.duration)
						? Math.min(resumeAt, Math.max(0, video.duration - 0.25))
						: resumeAt;
					return true;
				}
				return false;
			};

			if (trySeek()) return;
			const interval = setInterval(() => {
				if (trySeek()) clearInterval(interval);
			}, 250);
			const stop = setTimeout(() => clearInterval(interval), 10_000);
			return () => {
				clearInterval(interval);
				clearTimeout(stop);
			};
		}, [isMp4Source, data.id]);

		let videoSrc: string;
		const rawFallbackSrc =
			data.source.type === "webMP4"
				? `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=raw-preview`
				: undefined;
		let enableCrossOrigin = false;

		if (isSegmentsSource) {
			const requireComplete = userConfirmedStopped ? "&requireComplete=1" : "";
			videoSrc = `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=segments-master${requireComplete}`;
		} else if (isMp4Source) {
			videoSrc = `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=mp4`;
			enableCrossOrigin = true;
		} else if (
			NODE_ENV === "development" ||
			((data.skipProcessing === true || data.jobStatus !== "COMPLETE") &&
				data.source.type === "MediaConvert")
		) {
			videoSrc = `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=master`;
		} else if (data.source.type === "MediaConvert") {
			videoSrc = `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=video`;
		} else {
			videoSrc = `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=video`;
		}

		return (
			<>
				<div
					className="relative h-full"
					style={{ viewTransitionName: "cap-edit-video" }}
				>
					{isActivelyRecording ? (
						<div className="relative h-full overflow-hidden rounded-xl bg-black">
							<HLSVideoPlayer
								videoId={data.id}
								mediaPlayerClassName="w-full h-full max-w-full max-h-full rounded-xl"
								videoSrc={videoSrc}
								duration={data.duration}
								disableCaptions={true}
								chaptersSrc=""
								captionsSrc=""
								videoRef={videoRef}
								hasActiveUpload={data.hasActiveUpload}
								isLiveSegments={isSegmentsSource}
								allowSegmentProbeDuringUpload={true}
								autoplay={true}
								previewMode="background"
							/>
							<div className="absolute inset-0 z-20">
								<RecordingInProgressOverlay
									onConfirmStopped={handleConfirmStopped}
									isConfirmingStopped={isConfirmingStopped}
									confirmStoppedError={confirmStoppedError}
									className="h-full"
									variant="overlay"
								/>
							</div>
						</div>
					) : isProcessingInProgress ? (
						<PreparingVideoOverlay className="h-full" />
					) : isOverShareLimit ? (
						// Quota gate: the player is never mounted, so the video is not
						// fetched or playable until the owner upgrades (server recomputes
						// the flag on the next load). Recording/processing branches above
						// keep priority so in-flight uploads always finalize.
						<ShareableLinkLimitOverlay
							isOwner={viewerIsOwner}
							onUpgrade={openUpgradeModal}
							onUpgradeHover={() => {
								void importUpgradeModal();
							}}
							className="h-full"
						/>
					) : isMp4Source ? (
						<CapVideoPlayer
							videoId={data.id}
							mediaPlayerClassName={clsx(
								"w-full h-full max-w-full max-h-full overflow-visible",
								// Timeline view: the player is a slice of the widescreen
								// theater block, so no rounded corners against the black.
								externalTimeline ? "rounded-none" : "rounded-xl",
							)}
							videoSrc={videoSrc}
							rawFallbackSrc={rawFallbackSrc}
							duration={data.duration}
							defaultPlaybackSpeed={defaultPlaybackSpeed}
							showPlaybackStatusBadge={showPlaybackStatusBadge}
							disableCaptions={areCaptionsDisabled ?? false}
							disableCommentStamps={areCommentStampsDisabled ?? false}
							disableReactionStamps={areReactionStampsDisabled ?? false}
							externalTimeline={externalTimeline}
							controlsPortalEl={controlsPortalEl}
							chaptersSrc={areChaptersDisabled ? "" : chaptersUrl || ""}
							captionsSrc={areCaptionsDisabled ? "" : subtitleUrl || ""}
							videoRef={videoRef}
							enableCrossOrigin={enableCrossOrigin}
							hasActiveUpload={data.hasActiveUpload}
							blockPlaybackDuringProcessing={isEditProcessing}
							onUploadComplete={handleUploadComplete}
							comments={stampComments}
							onSeek={handleSeek}
							captionLanguage={captionContext.selectedLanguage}
							onCaptionLanguageChange={handleCaptionLanguageChange}
							availableCaptions={captionContext.availableTranslations}
							isCaptionLoading={captionContext.isTranslating}
							hasCaptions={
								data.transcriptionStatus === "COMPLETE" ||
								liveVttContent != null
							}
							canRetryProcessing={canRetryProcessing}
						/>
					) : (
						<HLSVideoPlayer
							videoId={data.id}
							mediaPlayerClassName={clsx(
								"w-full h-full max-w-full max-h-full",
								externalTimeline ? "rounded-none" : "rounded-xl",
							)}
							videoSrc={videoSrc}
							duration={data.duration}
							defaultPlaybackSpeed={defaultPlaybackSpeed}
							externalTimeline={externalTimeline}
							controlsPortalEl={controlsPortalEl}
							disableCaptions={areCaptionsDisabled ?? false}
							chaptersSrc={areChaptersDisabled ? "" : chaptersUrl || ""}
							captionsSrc={areCaptionsDisabled ? "" : subtitleUrl || ""}
							videoRef={videoRef}
							hasActiveUpload={data.hasActiveUpload}
							isLiveSegments={isSegmentsSource}
							allowSegmentProbeDuringUpload={
								isSegmentsSource && userConfirmedStopped
							}
							captionLanguage={captionContext.selectedLanguage}
							onCaptionLanguageChange={handleCaptionLanguageChange}
							availableCaptions={captionContext.availableTranslations}
							isCaptionLoading={captionContext.isTranslating}
							hasCaptions={
								data.transcriptionStatus === "COMPLETE" ||
								liveVttContent != null
							}
							canRetryProcessing={canRetryProcessing}
						/>
					)}
					{showFinalizeRecordingControl && (
						<div className="absolute bottom-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-1.5">
							<div className="flex items-center gap-1.5">
								<button
									type="button"
									onClick={handleConfirmStopped}
									disabled={isConfirmingStopped}
									className="inline-flex h-7 items-center gap-1.5 rounded-md border border-white/15 bg-black/65 px-2.5 text-[11px] font-medium text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-70"
								>
									{isConfirmingStopped ? (
										<Loader2Icon className="size-3 animate-spin" />
									) : (
										<CheckCircle2 className="size-3" />
									)}
									{isConfirmingStopped
										? "Marking as completed..."
										: "Mark video as completed"}
								</button>
								<TooltipPrimitive.Provider delayDuration={150}>
									<Tooltip
										position="top"
										className="max-w-[260px] items-start text-left leading-relaxed"
										content="We didn't receive confirmation that this recording finished uploading. Mark it as completed to publish what's been uploaded. Next time, keep the desktop app open after you stop recording until the video loads here, so all files finish uploading."
									>
										<button
											type="button"
											aria-label="Why this recording needs to be marked as completed"
											className="inline-flex size-7 items-center justify-center rounded-md border border-white/15 bg-black/65 text-white/80 shadow-sm backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
										>
											<Info className="size-3.5" />
										</button>
									</Tooltip>
								</TooltipPrimitive.Provider>
							</div>
							{confirmStoppedError && (
								<p className="max-w-56 rounded-md bg-black/70 px-2 py-1 text-[11px] text-red-100">
									{confirmStoppedError}
								</p>
							)}
						</div>
					)}
				</div>

				{!data.owner.isPro && !isOverShareLimit && (
					<div className="absolute top-4 left-4 z-30">
						<button
							type="button"
							className="block"
							onClick={(e) => {
								e.stopPropagation();
								openUpgradeModal();
							}}
							onPointerEnter={() => {
								void importUpgradeModal();
							}}
						>
							<div className="relative">
								<div className="opacity-50 transition-opacity hover:opacity-100 peer">
									<Logo className="w-auto h-4 sm:h-8" white={true} />
								</div>

								<div className="absolute left-0 top-8 transition-transform duration-300 ease-in-out origin-top scale-y-0 peer-hover:scale-y-100">
									<p className="text-white text-xs font-medium whitespace-nowrap bg-black bg-opacity-50 px-2 py-0.5 rounded">
										Remove watermark
									</p>
								</div>
							</div>
						</button>
					</div>
				)}
				{trackUploadProgress && (
					<UploadProgressTracker
						videoId={data.id}
						onChange={setSegmentUploadProgress}
					/>
				)}
				{upgradeModalMounted && (
					<UpgradeModal
						open={upgradeModalOpen}
						onOpenChange={setUpgradeModalOpen}
					/>
				)}
			</>
		);
	},
);

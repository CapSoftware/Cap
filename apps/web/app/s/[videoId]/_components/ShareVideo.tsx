import type { comments as commentsSchema } from "@cap/database/schema";
import { NODE_ENV } from "@cap/env";
import { Logo } from "@cap/ui";
import type { ImageUpload, VideoAnalytics } from "@cap/web-domain";
import { useTranscript } from "hooks/use-transcript";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { UpgradeModal } from "@/components/UpgradeModal";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import type { ShareAnalyticsContext, VideoData } from "../types";
import { CapVideoPlayer } from "./CapVideoPlayer";
import { HLSVideoPlayer } from "./HLSVideoPlayer";
import {
	formatChaptersAsVTT,
	formatTranscriptAsVTT,
	parseVTT,
	type TranscriptEntry,
} from "./utils/transcript-utils";

const SHARE_WATCH_TIME_ENABLED =
	process.env.NEXT_PUBLIC_SHARE_WATCH_TIME === "true";

declare global {
	interface Window {
		MSStream: unknown;
	}
}

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
	authorName: string | null;
	authorImage: ImageUpload.ImageUrl | null;
};

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
		aiProcessing?: boolean;
		analyticsContext?: ShareAnalyticsContext;
	}
>(
	(
		{
			data,
			comments,
			chapters = [],
			areCaptionsDisabled,
			areChaptersDisabled,
			areCommentStampsDisabled,
			areReactionStampsDisabled,
			analyticsContext,
		},
		ref,
	) => {
		const videoRef = useRef<HTMLVideoElement | null>(null);
		useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement, []);

		const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
		const [transcriptData, setTranscriptData] = useState<TranscriptEntry[]>([]);
		const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
		const [chaptersUrl, setChaptersUrl] = useState<string | null>(null);
		const [commentsData, setCommentsData] = useState<CommentWithAuthor[]>([]);

		const { data: transcriptContent, error: transcriptError } = useTranscript(
			data.id,
			data.transcriptionStatus,
		);

		const rpc = useRpcClient();
		const { mutate: captureEvent } = useEffectMutation({
			mutationFn: (event: VideoAnalytics.VideoCaptureEvent) =>
				rpc.VideosCaptureEvent(event),
		});

		const sessionId = useMemo(() => ensureShareSessionId(), []);
		const userAgentDetails = useMemo(
			() =>
				deriveUserAgentDetails(
					analyticsContext?.userAgent ??
						(typeof navigator !== "undefined"
							? navigator.userAgent
							: undefined),
				),
			[analyticsContext?.userAgent],
		);

		const analyticsBase = useMemo(
			() => ({
				video: data.id,
				sessionId: sessionId ?? undefined,
				city: analyticsContext?.city ?? undefined,
				country: analyticsContext?.country ?? undefined,
				referrer: analyticsContext?.referrer ?? undefined,
				referrerUrl: analyticsContext?.referrerUrl ?? undefined,
				utmSource: analyticsContext?.utmSource ?? undefined,
				utmMedium: analyticsContext?.utmMedium ?? undefined,
				utmCampaign: analyticsContext?.utmCampaign ?? undefined,
				utmTerm: analyticsContext?.utmTerm ?? undefined,
				utmContent: analyticsContext?.utmContent ?? undefined,
				device: userAgentDetails.device ?? undefined,
				browser: userAgentDetails.browser ?? undefined,
				os: userAgentDetails.os ?? undefined,
			}),
			[
				analyticsContext?.city,
				analyticsContext?.country,
				analyticsContext?.referrer,
				analyticsContext?.referrerUrl,
				analyticsContext?.utmSource,
				analyticsContext?.utmMedium,
				analyticsContext?.utmCampaign,
				analyticsContext?.utmTerm,
				analyticsContext?.utmContent,
				data.id,
				sessionId,
				userAgentDetails.browser,
				userAgentDetails.device,
				userAgentDetails.os,
			],
		);

		const watchTimeTrackingEnabled =
			SHARE_WATCH_TIME_ENABLED && Boolean(sessionId) && Boolean(analyticsContext);

		const watchStateRef = useRef({
			startedAt: null as number | null,
			accumulatedMs: 0,
		});
		const hasFlushedRef = useRef(false);
		const hasInitializedRef = useRef(false);
		const didStrictCleanupRef = useRef(false);

		const startWatchTimer = useCallback(() => {
			if (!watchTimeTrackingEnabled) return;
			if (watchStateRef.current.startedAt !== null) return;
			watchStateRef.current.startedAt = nowMs();
		}, [watchTimeTrackingEnabled]);

		const stopWatchTimer = useCallback(() => {
			if (!watchTimeTrackingEnabled) return;
			if (watchStateRef.current.startedAt === null) return;
			watchStateRef.current.accumulatedMs +=
				nowMs() - watchStateRef.current.startedAt;
			watchStateRef.current.startedAt = null;
		}, [watchTimeTrackingEnabled]);

		const readWatchTimeSeconds = useCallback(() => {
			if (!watchTimeTrackingEnabled) return 0;
			stopWatchTimer();
			return watchStateRef.current.accumulatedMs / 1000;
		}, [stopWatchTimer, watchTimeTrackingEnabled]);

		const flushAnalyticsEvent = useCallback(
			(_reason?: string) => {
				if (!watchTimeTrackingEnabled) return;
				if (hasFlushedRef.current) return;
				const watchTimeSeconds = Number(
					Math.max(0, readWatchTimeSeconds()).toFixed(2),
				);
				const payload: VideoAnalytics.VideoCaptureEvent = {
					...analyticsBase,
					watchTimeSeconds,
				};
				captureEvent(payload);
				hasFlushedRef.current = true;
			},
			[analyticsBase, captureEvent, readWatchTimeSeconds, watchTimeTrackingEnabled],
		);

		useEffect(() => {
			if (!watchTimeTrackingEnabled) return;
			if (hasInitializedRef.current) {
				flushAnalyticsEvent(`video-change-${data.id}`);
			} else {
				hasInitializedRef.current = true;
			}
			watchStateRef.current = { startedAt: null, accumulatedMs: 0 };
			hasFlushedRef.current = false;
		}, [data.id, flushAnalyticsEvent, watchTimeTrackingEnabled]);

		useEffect(
			() => () => {
				if (!watchTimeTrackingEnabled) return;
				if (didStrictCleanupRef.current) {
					flushAnalyticsEvent("unmount");
				} else {
					didStrictCleanupRef.current = true;
				}
			},
			[flushAnalyticsEvent, watchTimeTrackingEnabled],
		);

		useEffect(() => {
			if (!watchTimeTrackingEnabled) return;
			if (typeof window === "undefined") return;
			let rafId: number | null = null;
			let cleanup: (() => void) | undefined;

			const attach = () => {
				const video = videoRef.current;
				if (!video) return false;

				const handlePlay = () => startWatchTimer();
				const handlePause = () => stopWatchTimer();
				const handleEnded = () => {
					stopWatchTimer();
					flushAnalyticsEvent("ended");
				};

				video.addEventListener("play", handlePlay);
				video.addEventListener("playing", handlePlay);
				video.addEventListener("pause", handlePause);
				video.addEventListener("waiting", handlePause);
				video.addEventListener("seeking", handlePause);
				video.addEventListener("ended", handleEnded);

				cleanup = () => {
					video.removeEventListener("play", handlePlay);
					video.removeEventListener("playing", handlePlay);
					video.removeEventListener("pause", handlePause);
					video.removeEventListener("waiting", handlePause);
					video.removeEventListener("seeking", handlePause);
					video.removeEventListener("ended", handleEnded);
				};

				return true;
			};

			if (!attach()) {
				const check = () => {
					if (attach()) return;
					rafId = window.requestAnimationFrame(check);
				};
				rafId = window.requestAnimationFrame(check);
			}

			return () => {
				cleanup?.();
				if (rafId) window.cancelAnimationFrame(rafId);
			};
		}, [
			flushAnalyticsEvent,
			startWatchTimer,
			stopWatchTimer,
			watchTimeTrackingEnabled,
		]);

		useEffect(() => {
			if (!watchTimeTrackingEnabled) return;
			if (typeof window === "undefined") return;
			const handleVisibility = () => {
				if (document.visibilityState === "hidden") {
					flushAnalyticsEvent("visibility");
				}
			};
			const handlePageHide = () => flushAnalyticsEvent("pagehide");
			const handleBeforeUnload = () => flushAnalyticsEvent("beforeunload");

			document.addEventListener("visibilitychange", handleVisibility);
			window.addEventListener("pagehide", handlePageHide);
			window.addEventListener("beforeunload", handleBeforeUnload);

			return () => {
				document.removeEventListener("visibilitychange", handleVisibility);
				window.removeEventListener("pagehide", handlePageHide);
				window.removeEventListener("beforeunload", handleBeforeUnload);
			};
		}, [flushAnalyticsEvent, watchTimeTrackingEnabled]);

		useEffect(
			() => () => {
				if (!watchTimeTrackingEnabled) return;
				flushAnalyticsEvent("unmount");
			},
			[flushAnalyticsEvent, watchTimeTrackingEnabled],
		);

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

		// Handle seek functionality
		const handleSeek = (time: number) => {
			if (videoRef.current) {
				videoRef.current.currentTime = time;
			}
		};

		useEffect(() => {
			if (transcriptContent) {
				const parsed = parseVTT(transcriptContent);
				setTranscriptData(parsed);
			} else if (transcriptError) {
				console.error(
					"[Transcript] Transcript error from React Query:",
					transcriptError.message,
				);
			}
		}, [transcriptContent, transcriptError]);

		// Handle subtitle URL creation
		useEffect(() => {
			if (
				data.transcriptionStatus === "COMPLETE" &&
				transcriptData &&
				transcriptData.length > 0
			) {
				const vttContent = formatTranscriptAsVTT(transcriptData);
				const blob = new Blob([vttContent], { type: "text/vtt" });
				const newUrl = URL.createObjectURL(blob);

				// Clean up previous URL
				if (subtitleUrl) {
					URL.revokeObjectURL(subtitleUrl);
				}

				setSubtitleUrl(newUrl);

				return () => {
					URL.revokeObjectURL(newUrl);
				};
			} else {
				// Clean up if no longer needed
				if (subtitleUrl) {
					URL.revokeObjectURL(subtitleUrl);
					setSubtitleUrl(null);
				}
			}
		}, [data.transcriptionStatus, transcriptData, subtitleUrl]);

		// Handle chapters URL creation
		useEffect(() => {
			if (chapters?.length > 0) {
				const vttContent = formatChaptersAsVTT(chapters);
				const blob = new Blob([vttContent], { type: "text/vtt" });
				const newUrl = URL.createObjectURL(blob);

				// Clean up previous URL
				if (chaptersUrl) {
					URL.revokeObjectURL(chaptersUrl);
				}

				setChaptersUrl(newUrl);

				return () => {
					URL.revokeObjectURL(newUrl);
				};
			} else {
				// Clean up if no longer needed
				if (chaptersUrl) {
					URL.revokeObjectURL(chaptersUrl);
					setChaptersUrl(null);
				}
			}
		}, [chapters, chaptersUrl]);

		const isMp4Source =
			data.source.type === "desktopMP4" || data.source.type === "webMP4";
		let videoSrc: string;
		let enableCrossOrigin = false;

		if (isMp4Source) {
			videoSrc = `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=mp4`;
			// Start with CORS enabled for MP4 sources, CapVideoPlayer will disable if needed
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
				<div className="relative h-full">
					{isMp4Source ? (
						<CapVideoPlayer
							videoId={data.id}
							mediaPlayerClassName="w-full h-full max-w-full max-h-full rounded-xl overflow-visible"
							videoSrc={videoSrc}
							disableCaptions={areCaptionsDisabled ?? false}
							disableCommentStamps={areCommentStampsDisabled ?? false}
							disableReactionStamps={areReactionStampsDisabled ?? false}
							chaptersSrc={areChaptersDisabled ? "" : chaptersUrl || ""}
							captionsSrc={areCaptionsDisabled ? "" : subtitleUrl || ""}
							videoRef={videoRef}
							enableCrossOrigin={enableCrossOrigin}
							hasActiveUpload={data.hasActiveUpload}
							comments={commentsData.map((comment) => ({
								id: comment.id,
								type: comment.type,
								timestamp: comment.timestamp,
								content: comment.content,
								authorName: comment.authorName,
								authorImage: comment.authorImage ?? undefined,
							}))}
							onSeek={handleSeek}
						/>
					) : (
						<HLSVideoPlayer
							videoId={data.id}
							mediaPlayerClassName="w-full h-full max-w-full max-h-full rounded-xl"
							videoSrc={videoSrc}
							disableCaptions={areCaptionsDisabled ?? false}
							chaptersSrc={areChaptersDisabled ? "" : chaptersUrl || ""}
							captionsSrc={areCaptionsDisabled ? "" : subtitleUrl || ""}
							videoRef={videoRef}
							hasActiveUpload={data.hasActiveUpload}
						/>
					)}
				</div>

				{!data.owner.isPro && (
					<div className="absolute top-4 left-4 z-30">
						<button
							type="button"
							aria-label="Upgrade to remove watermark"
							className="block cursor-pointer bg-transparent border-0 p-0"
							onClick={(e) => {
								e.stopPropagation();
								setUpgradeModalOpen(true);
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
				<UpgradeModal
					open={upgradeModalOpen}
					onOpenChange={setUpgradeModalOpen}
				/>
			</>
		);
	},
);

const SHARE_SESSION_STORAGE_KEY = "cap_share_view_session";

const ensureShareSessionId = () => {
	if (typeof window === "undefined") return undefined;
	try {
		const existing = window.sessionStorage.getItem(SHARE_SESSION_STORAGE_KEY);
		if (existing) return existing;
		const newId =
			typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: Math.random().toString(36).slice(2);
		window.sessionStorage.setItem(SHARE_SESSION_STORAGE_KEY, newId);
		return newId;
	} catch {
		return undefined;
	}
};

const nowMs = () =>
	typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();

type UserAgentDetails = {
	device?: string;
	browser?: string;
	os?: string;
};

const deriveUserAgentDetails = (ua?: string): UserAgentDetails => {
	if (!ua) return {};
	const value = ua.toLowerCase();
	const details: UserAgentDetails = {};

	if (
		/ipad|tablet/.test(value) ||
		(/android/.test(value) && !/mobile/.test(value))
	) {
		details.device = "tablet";
	} else if (/mobi|iphone|ipod|android/.test(value)) {
		details.device = "mobile";
	} else {
		details.device = "desktop";
	}

	if (/edg\//.test(value)) details.browser = "Edge";
	else if (
		/chrome|crios|crmo/.test(value) &&
		!/opr\//.test(value) &&
		!/edg\//.test(value)
	)
		details.browser = "Chrome";
	else if (/safari/.test(value) && !/chrome|crios|android/.test(value))
		details.browser = "Safari";
	else if (/firefox|fxios/.test(value)) details.browser = "Firefox";
	else if (/opr\//.test(value) || /opera/.test(value))
		details.browser = "Opera";
	else if (/msie|trident/.test(value)) details.browser = "IE";
	else details.browser = "Other";

	if (/windows nt/.test(value)) details.os = "Windows";
	else if (/mac os x/.test(value) && !/iphone|ipad|ipod/.test(value))
		details.os = "macOS";
	else if (/iphone|ipad|ipod/.test(value)) details.os = "iOS";
	else if (/android/.test(value)) details.os = "Android";
	else if (/cros/.test(value)) details.os = "ChromeOS";
	else if (/linux/.test(value)) details.os = "Linux";
	else details.os = "Other";

	return details;
};

import type { comments as commentsSchema } from "@cap/database/schema";
import { NODE_ENV } from "@cap/env";
import { Logo } from "@cap/ui";
import type { ImageUpload } from "@cap/web-domain";
import { useTranscript } from "hooks/use-transcript";
import { useRouter } from "next/navigation";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { UpgradeModal } from "@/components/UpgradeModal";
import type { VideoData } from "../types";
import { type CaptionLanguage, useCaptionContext } from "./CaptionContext";
import { CapVideoPlayer } from "./CapVideoPlayer";
import { HLSVideoPlayer } from "./HLSVideoPlayer";
import { useUploadProgress } from "./ProgressCircle";
import {
	PreparingVideoOverlay,
	RecordingInProgressOverlay,
} from "./RecordingInProgress";
import { formatChaptersAsVTT } from "./utils/transcript-utils";

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
	authorName: string | null;
	authorImage: ImageUpload.ImageUrl | null;
};

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

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
		aiGenerationStatus?: AiGenerationStatus | null;
		canRetryProcessing?: boolean;
		showPlaybackStatusBadge?: boolean;
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
			canRetryProcessing,
			showPlaybackStatusBadge = false,
		},
		ref,
	) => {
		const videoRef = useRef<HTMLVideoElement | null>(null);
		useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement, []);
		const router = useRouter();

		const captionContext = useCaptionContext();

		const handleCaptionLanguageChange = (language: string) => {
			captionContext.setSelectedLanguage(language as CaptionLanguage);
		};

		const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
		const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
		const [chaptersUrl, setChaptersUrl] = useState<string | null>(null);
		const [commentsData, setCommentsData] = useState<CommentWithAuthor[]>([]);
		const [userConfirmedStopped, setUserConfirmedStopped] = useState(false);
		const segmentUploadProgress = useUploadProgress(
			data.id,
			data.source.type === "desktopSegments" && (data.hasActiveUpload ?? false),
		);

		const { data: transcriptContent, error: transcriptError } = useTranscript(
			data.id,
			data.transcriptionStatus,
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

			if (data.transcriptionStatus === "COMPLETE" && vttContent) {
				const blob = new Blob([vttContent], { type: "text/vtt" });
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
		const isActivelyRecording =
			isSegmentsSource &&
			(data.hasActiveUpload ?? false) &&
			!userConfirmedStopped &&
			segmentUploadProgress?.status === "uploading";

		const isProcessingInProgress =
			isSegmentsSource &&
			(data.hasActiveUpload ?? false) &&
			!isActivelyRecording &&
			segmentUploadProgress !== null;

		const prevProgressRef = useRef<typeof segmentUploadProgress>(
			segmentUploadProgress,
		);
		const [awaitingSourceRefresh, setAwaitingSourceRefresh] = useState(false);
		const refreshTriggeredRef = useRef(false);

		useEffect(() => {
			const prev = prevProgressRef.current;
			prevProgressRef.current = segmentUploadProgress;

			if (refreshTriggeredRef.current || !isSegmentsSource) return;

			const prevWasActive = prev !== null;
			const isNowComplete = segmentUploadProgress === null;

			if (prevWasActive && isNowComplete) {
				refreshTriggeredRef.current = true;
				setAwaitingSourceRefresh(true);
				router.refresh();
			}
		}, [segmentUploadProgress, router, isSegmentsSource]);

		useEffect(() => {
			if (awaitingSourceRefresh && !isSegmentsSource) {
				setAwaitingSourceRefresh(false);
			}
		}, [awaitingSourceRefresh, isSegmentsSource]);

		let videoSrc: string;
		const rawFallbackSrc =
			data.source.type === "webMP4"
				? `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=raw-preview`
				: undefined;
		let enableCrossOrigin = false;

		if (isSegmentsSource) {
			videoSrc = `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=segments-master`;
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
				<div className="relative h-full">
					{isActivelyRecording ? (
						<RecordingInProgressOverlay
							onConfirmStopped={() => setUserConfirmedStopped(true)}
							className="h-full"
						/>
					) : isProcessingInProgress || awaitingSourceRefresh ? (
						<PreparingVideoOverlay className="h-full" />
					) : isMp4Source ? (
						<CapVideoPlayer
							videoId={data.id}
							mediaPlayerClassName="w-full h-full max-w-full max-h-full rounded-xl overflow-visible"
							videoSrc={videoSrc}
							rawFallbackSrc={rawFallbackSrc}
							duration={data.duration}
							showPlaybackStatusBadge={showPlaybackStatusBadge}
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
							captionLanguage={captionContext.selectedLanguage}
							onCaptionLanguageChange={handleCaptionLanguageChange}
							availableCaptions={captionContext.availableTranslations}
							isCaptionLoading={captionContext.isTranslating}
							hasCaptions={data.transcriptionStatus === "COMPLETE"}
							canRetryProcessing={canRetryProcessing}
						/>
					) : (
						<HLSVideoPlayer
							videoId={data.id}
							mediaPlayerClassName="w-full h-full max-w-full max-h-full rounded-xl"
							videoSrc={videoSrc}
							duration={data.duration}
							disableCaptions={areCaptionsDisabled ?? false}
							chaptersSrc={areChaptersDisabled ? "" : chaptersUrl || ""}
							captionsSrc={areCaptionsDisabled ? "" : subtitleUrl || ""}
							videoRef={videoRef}
							hasActiveUpload={data.hasActiveUpload}
							isLiveSegments={isSegmentsSource}
							captionLanguage={captionContext.selectedLanguage}
							onCaptionLanguageChange={handleCaptionLanguageChange}
							availableCaptions={captionContext.availableTranslations}
							isCaptionLoading={captionContext.isTranslating}
							hasCaptions={data.transcriptionStatus === "COMPLETE"}
							canRetryProcessing={canRetryProcessing}
						/>
					)}
				</div>

				{!data.owner.isPro && (
					<div className="absolute top-4 left-4 z-30">
						<button
							type="button"
							className="block"
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

import type { comments as commentsSchema } from "@cap/database/schema";
import { NODE_ENV } from "@cap/env";
import { Logo } from "@cap/ui";
import type { ImageUpload } from "@cap/web-domain";
import { useTranscript } from "hooks/use-transcript";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { UpgradeModal } from "@/components/UpgradeModal";
import type { VideoData } from "../types";
import { type CaptionLanguage, useCaptionContext } from "./CaptionContext";
import { CapVideoPlayer } from "./CapVideoPlayer";
import { HLSVideoPlayer } from "./HLSVideoPlayer";
import { formatChaptersAsVTT } from "./utils/transcript-utils";

declare global {
	interface Window {
		MSStream: any;
	}
}

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
		savedRenderProcessing?: boolean;
		savedRenderMessage?: string;
		hasSavedRender?: boolean;
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
			savedRenderProcessing,
			savedRenderMessage,
			hasSavedRender,
		},
		ref,
	) => {
		const videoRef = useRef<HTMLVideoElement | null>(null);
		useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement, []);

		const captionContext = useCaptionContext();

		const handleCaptionLanguageChange = (language: string) => {
			captionContext.setSelectedLanguage(language as CaptionLanguage);
		};

		const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
		const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
		const [chaptersUrl, setChaptersUrl] = useState<string | null>(null);
		const [commentsData, setCommentsData] = useState<CommentWithAuthor[]>([]);

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

		const isWebStudio = data.source.type === "webStudio";
		const studioNeedsRender = isWebStudio && !hasSavedRender;

		const isMp4Source =
			data.source.type === "desktopMP4" ||
			data.source.type === "webMP4" ||
			data.source.type === "webStudio" ||
			hasSavedRender === true;
		let videoSrc: string;
		let enableCrossOrigin = false;

		if (isMp4Source) {
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

		// const videoMetadata = data.metadata as VideoMetadata | null;
		// const enhancedAudioStatus = videoMetadata?.enhancedAudioStatus ?? null;

		// const enhancedAudioUrl = useMemo(() => {
		// 	if (enhancedAudioStatus === "COMPLETE" && data.owner.isPro) {
		// 		return `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&fileType=enhanced-audio`;
		// 	}
		// 	return null;
		// }, [enhancedAudioStatus, data.owner.isPro, data.owner.id, data.id]);

		return (
			<>
				<div className="relative h-full">
					{savedRenderProcessing && (
						<div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 bg-black/70 text-white text-xs rounded-full">
							{savedRenderMessage || "Processing your saved changes..."}
						</div>
					)}
					{studioNeedsRender ? (
						<div className="flex flex-col items-center justify-center w-full h-full bg-gray-2 rounded-xl">
							<p className="text-gray-11 text-sm mb-3">
								This recording was made in Studio Mode
							</p>
							<a
								href={`/editor/${data.id}`}
								className="px-4 py-2 bg-gray-12 text-gray-1 text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
							>
								Open Editor
							</a>
						</div>
					) : isMp4Source ? (
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
							captionLanguage={captionContext.selectedLanguage}
							onCaptionLanguageChange={handleCaptionLanguageChange}
							availableCaptions={captionContext.availableTranslations}
							isCaptionLoading={captionContext.isTranslating}
							hasCaptions={data.transcriptionStatus === "COMPLETE"}
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
							captionLanguage={captionContext.selectedLanguage}
							onCaptionLanguageChange={handleCaptionLanguageChange}
							availableCaptions={captionContext.availableTranslations}
							isCaptionLoading={captionContext.isTranslating}
							hasCaptions={data.transcriptionStatus === "COMPLETE"}
						/>
					)}
				</div>

				{!data.owner.isPro && (
					<div className="absolute top-4 left-4 z-30">
						<div
							className="block cursor-pointer"
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
						</div>
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

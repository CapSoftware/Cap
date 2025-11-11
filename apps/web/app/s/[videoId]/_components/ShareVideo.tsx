import type { userSelectProps } from "@cap/database/auth/session";
import type { comments as commentsSchema, videos } from "@cap/database/schema";
import { NODE_ENV } from "@cap/env";
import { Logo } from "@cap/ui";
import type { ImageUpload } from "@cap/web-domain";
import { useTranscript } from "hooks/use-transcript";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";
import { UpgradeModal } from "@/components/UpgradeModal";
import type { VideoData } from "../types";
import { CapVideoPlayer } from "./CapVideoPlayer";
import { HLSVideoPlayer } from "./HLSVideoPlayer";
import {
	formatChaptersAsVTT,
	formatTranscriptAsVTT,
	parseVTT,
	type TranscriptEntry,
} from "./utils/transcript-utils";

declare global {
	interface Window {
		MSStream: any;
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
		}, [data.transcriptionStatus, transcriptData]);

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
		}, [chapters]);

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

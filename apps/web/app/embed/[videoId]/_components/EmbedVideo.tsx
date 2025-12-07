"use client";

import type { userSelectProps } from "@cap/database/auth/session";
import type { comments as commentsSchema, videos } from "@cap/database/schema";
import { NODE_ENV } from "@cap/env";
import { Avatar, Logo } from "@cap/ui";
import { AnimatePresence, motion } from "framer-motion";
import { useTranscript } from "hooks/use-transcript";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { CapVideoPlayer } from "@/app/s/[videoId]/_components/CapVideoPlayer";
import { HLSVideoPlayer } from "@/app/s/[videoId]/_components/HLSVideoPlayer";
import {
	formatChaptersAsVTT,
	formatTranscriptAsVTT,
	parseVTT,
	type TranscriptEntry,
} from "@/app/s/[videoId]/_components/utils/transcript-utils";

declare global {
	interface Window {
		MSStream: any;
	}
}

const formatTime = (time: number) => {
	const minutes = Math.floor(time / 60);
	const seconds = Math.floor(time % 60);
	return `${minutes.toString().padStart(2, "0")}:${seconds
		.toString()
		.padStart(2, "0")}`;
};

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
	authorName: string | null;
};

export const EmbedVideo = forwardRef<
	HTMLVideoElement,
	{
		data: Omit<typeof videos.$inferSelect, "password"> & {
			hasActiveUpload: boolean | undefined;
		};
		user: typeof userSelectProps | null;
		comments: CommentWithAuthor[];
		chapters?: { title: string; start: number }[];
		aiProcessing?: boolean;
		ownerName?: string | null;
		autoplay?: boolean;
	}
>(
	(
		{
			data,
			user,
			comments,
			chapters = [],
			aiProcessing = false,
			ownerName,
			autoplay = false,
		},
		ref,
	) => {
		const videoRef = useRef<HTMLVideoElement>(null);
		useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

		const [transcriptData, setTranscriptData] = useState<TranscriptEntry[]>([]);
		const [longestDuration, setLongestDuration] = useState<number>(0);
		const [isPlaying, setIsPlaying] = useState(false);
		const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
		const [chaptersUrl, setChaptersUrl] = useState<string | null>(null);

		const { data: transcriptContent, error: transcriptError } = useTranscript(
			data.id,
			data.transcriptionStatus,
		);

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
			videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=mp4`;
			// Start with CORS enabled for MP4 sources, CapVideoPlayer will disable if needed
			enableCrossOrigin = true;
		} else if (
			NODE_ENV === "development" ||
			((data.skipProcessing === true || data.jobStatus !== "COMPLETE") &&
				data.source.type === "MediaConvert")
		) {
			videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=master`;
		} else if (data.source.type === "MediaConvert") {
			videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=video`;
		} else {
			videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=video`;
		}

		useEffect(() => {
			if (!videoRef.current) return;
			const player = videoRef.current;
			const handleLoadedMetadata = () => {
				setLongestDuration(player.duration);
			};

			if (player.readyState >= 1) {
				setLongestDuration(player.duration);
			} else {
				player.addEventListener("loadedmetadata", handleLoadedMetadata);
			}

			const listener = (arg: boolean) => {
				setIsPlaying(arg);
			};
			player.addEventListener("play", () => listener(true));
			player.addEventListener("pause", () => listener(false));
			return () => {
				player.removeEventListener("play", () => listener(true));
				player.removeEventListener("pause", () => listener(false));
				player.removeEventListener("loadedmetadata", handleLoadedMetadata);
			};
		}, []);

		return (
			<>
				<div className="relative w-screen h-screen rounded-xl">
					{isMp4Source ? (
						<CapVideoPlayer
							videoId={data.id}
							mediaPlayerClassName="w-full h-full"
							videoSrc={videoSrc}
							chaptersSrc={chaptersUrl || ""}
							captionsSrc={subtitleUrl || ""}
							videoRef={videoRef}
							enableCrossOrigin={enableCrossOrigin}
							hasActiveUpload={data.hasActiveUpload}
						/>
					) : (
						<HLSVideoPlayer
							videoId={data.id}
							mediaPlayerClassName="w-full h-full"
							videoSrc={videoSrc}
							chaptersSrc={chaptersUrl || ""}
							captionsSrc={subtitleUrl || ""}
							videoRef={videoRef}
							hasActiveUpload={data.hasActiveUpload}
						/>
					)}
				</div>

				<AnimatePresence>
					{!isPlaying && (
						<div className="absolute top-3 left-3 z-10 space-y-2">
							<motion.div
								initial={{ opacity: 0, y: 10 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: 10 }}
								transition={{ duration: 0.3, delay: 0.2 }}
								className="z-10 bg-black/50 backdrop-blur-md rounded-lg sm:rounded-xl px-2 py-1.5 sm:px-4 sm:py-3 border border-white/10 shadow-2xl"
							>
								<div className="flex gap-2 items-center sm:gap-3">
									{ownerName && (
										<Avatar
											name={ownerName}
											className="hidden flex-shrink-0 xs:flex xs:size-10"
											letterClass="xs:text-base font-medium"
										/>
									)}
									<div className="flex-1 min-w-0">
										<a
											href={`/s/${data.id}`}
											target="_blank"
											rel="noopener noreferrer"
											className="block"
											onClick={(e) => e.stopPropagation()}
										>
											<h1 className="text-xs max-w-[175px] xs:max-w-[300px] sm:max-w-[400px] font-semibold md:max-w-[500px] leading-tight text-white truncate transition-all duration-200 cursor-pointer sm:text-xl md:text-2xl hover:underline">
												{data.name}
											</h1>
										</a>
										<div className="flex items-center gap-1 sm:gap-2 mt-0.5 sm:mt-1">
											{ownerName && (
												<p className="text-xs font-medium text-gray-300 truncate sm:text-sm">
													{ownerName}
												</p>
											)}
											{ownerName && longestDuration > 0 && (
												<>
													<span className="text-xs text-gray-400">•</span>
													<p className="text-xs text-gray-300 sm:text-sm">
														{formatTime(longestDuration)}
													</p>
												</>
											)}
										</div>
									</div>
								</div>
							</motion.div>
							<motion.button
								initial={{ opacity: 0, y: 10 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: 10 }}
								transition={{ duration: 0.3, delay: 0.1 }}
								onClick={(e) => {
									e.stopPropagation();
									window.open("https://cap.so", "_blank");
								}}
								className="hidden z-10 gap-2 items-center px-3 py-2 text-sm rounded-full border backdrop-blur-sm transition-colors duration-200 sm:flex border-white/10 w-fit text-white/80 hover:text-white bg-black/50"
								aria-label="Powered by Cap"
							>
								<span className="text-xs md:text-sm text-white/80">
									Powered by
								</span>
								<Logo className="w-auto h-4" white={true} />
							</motion.button>
						</div>
					)}
				</AnimatePresence>
			</>
		);
	},
);

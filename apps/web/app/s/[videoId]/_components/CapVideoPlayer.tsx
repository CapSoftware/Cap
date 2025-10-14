"use client";

import { LogoSpinner } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { faPlay } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import CommentStamp from "./CommentStamp";
import ProgressCircle, { useUploadProgress } from "./ProgressCircle";
import {
	MediaPlayer,
	MediaPlayerCaptions,
	MediaPlayerControls,
	MediaPlayerControlsOverlay,
	MediaPlayerError,
	MediaPlayerFullscreen,
	MediaPlayerLoading,
	MediaPlayerPiP,
	MediaPlayerPlay,
	MediaPlayerSeek,
	MediaPlayerSeekBackward,
	MediaPlayerSeekForward,
	MediaPlayerSettings,
	MediaPlayerTime,
	MediaPlayerVideo,
	MediaPlayerVolume,
	MediaPlayerVolumeIndicator,
} from "./video/media-player";

interface Props {
	videoSrc: string;
	videoId: Video.VideoId;
	chaptersSrc: string;
	captionsSrc: string;
	disableCaptions?: boolean;
	videoRef: React.RefObject<HTMLVideoElement | null>;
	mediaPlayerClassName?: string;
	autoplay?: boolean;
	enableCrossOrigin?: boolean;
	hasActiveUpload: boolean | undefined;
	disableCommentStamps?: boolean;
	disableReactionStamps?: boolean;
	comments?: Array<{
		id: string;
		timestamp: number | null;
		type: "text" | "emoji";
		content: string;
		authorName?: string | null;
	}>;
	onSeek?: (time: number) => void;
}

export function CapVideoPlayer({
	videoSrc,
	videoId,
	chaptersSrc,
	captionsSrc,
	disableCaptions,
	videoRef,
	mediaPlayerClassName,
	autoplay = false,
	enableCrossOrigin = false,
	hasActiveUpload,
	comments = [],
	disableCommentStamps = false,
	disableReactionStamps = false,
	onSeek,
}: Props) {
	const [currentCue, setCurrentCue] = useState<string>("");
	const [controlsVisible, setControlsVisible] = useState(false);
	const [mainControlsVisible, setMainControlsVisible] = useState(false);
	const [toggleCaptions, setToggleCaptions] = useState(true);
	const [showPlayButton, setShowPlayButton] = useState(false);
	const [videoLoaded, setVideoLoaded] = useState(false);
	const [hasPlayedOnce, setHasPlayedOnce] = useState(false);
	const [isMobile, setIsMobile] = useState(false);
	const retryCount = useRef(0);
	const retryTimeout = useRef<NodeJS.Timeout | null>(null);
	const startTime = useRef<number>(Date.now());
	const [hasError, setHasError] = useState(false);
	const [isRetrying, setIsRetrying] = useState(false);
	const isRetryingRef = useRef(false);
	const maxRetries = 3;
	const [duration, setDuration] = useState(0);

	useEffect(() => {
		const checkMobile = () => {
			setIsMobile(window.innerWidth < 640);
		};

		checkMobile();
		window.addEventListener("resize", checkMobile);

		return () => window.removeEventListener("resize", checkMobile);
	}, []);

	const uploadProgressRaw = useUploadProgress(
		videoId,
		hasActiveUpload || false,
	);
	// if the video comes back from S3, just ignore the upload progress.
	const uploadProgress = videoLoaded ? null : uploadProgressRaw;
	const isUploading = uploadProgress?.status === "uploading";

	const resolvedSrc = useQuery({
		queryKey: ["resolvedSrc", videoSrc],
		queryFn: async () => {
			try {
				const timestamp = Date.now();
				const urlWithTimestamp = videoSrc.includes("?")
					? `${videoSrc}&_t=${timestamp}`
					: `${videoSrc}?_t=${timestamp}`;

				const response = await fetch(urlWithTimestamp, {
					method: "GET",
					headers: { range: "bytes=0-0" },
				});
				const finalUrl = response.redirected ? response.url : urlWithTimestamp;

				// Check if the resolved URL is from a CORS-incompatible service
				const isCloudflareR2 = finalUrl.includes(".r2.cloudflarestorage.com");
				const isS3 =
					finalUrl.includes(".s3.") || finalUrl.includes("amazonaws.com");
				const isCorsIncompatible = isCloudflareR2 || isS3;

				let supportsCrossOrigin = enableCrossOrigin;

				// Set CORS based on URL compatibility BEFORE video element is created
				if (isCorsIncompatible) {
					console.log(
						"CapVideoPlayer: Detected CORS-incompatible URL, disabling crossOrigin:",
						finalUrl,
					);
					supportsCrossOrigin = false;
				}

				return { url: finalUrl, supportsCrossOrigin };
			} catch (error) {
				console.error("CapVideoPlayer: Error fetching new video URL:", error);
				const timestamp = Date.now();
				const fallbackUrl = videoSrc.includes("?")
					? `${videoSrc}&_t=${timestamp}`
					: `${videoSrc}?_t=${timestamp}`;
				return { fallbackUrl, supportsCrossOrigin: enableCrossOrigin };
			}
		},
		enabled: !isUploading && uploadProgressRaw?.status !== "fetching",
	});

	const reloadVideo = useCallback(async () => {
		const video = videoRef.current;
		if (!video || retryCount.current >= maxRetries) return;

		console.log(
			`Reloading video (attempt ${retryCount.current + 1}/${maxRetries})`,
		);

		const currentPosition = video.currentTime;
		const wasPlaying = !video.paused;

		video.load();

		if (currentPosition > 0) {
			const restorePosition = () => {
				video.currentTime = currentPosition;
				if (wasPlaying) {
					video
						.play()
						.catch((err) => console.error("Error resuming playback:", err));
				}
				video.removeEventListener("canplay", restorePosition);
			};
			video.addEventListener("canplay", restorePosition);
		}

		retryCount.current += 1;
	}, [maxRetries]);

	const setupRetry = useCallback(() => {
		if (retryTimeout.current) {
			clearTimeout(retryTimeout.current);
		}

		if (retryCount.current >= maxRetries) {
			console.error(`Video failed to load after ${maxRetries} attempts`);
			setHasError(true);
			isRetryingRef.current = false;
			setIsRetrying(false);
			return;
		}

		const elapsedMs = Date.now() - startTime.current;
		if (elapsedMs > 60000) {
			console.error("Video failed to load after 1 minute");
			setHasError(true);
			isRetryingRef.current = false;
			setIsRetrying(false);
			return;
		}

		let retryInterval: number;
		if (retryCount.current === 0) {
			retryInterval = 2000; // 2 seconds
		} else if (retryCount.current === 1) {
			retryInterval = 5000; // 5 seconds
		} else {
			retryInterval = 10000; // 10 seconds
		}

		console.log(
			`Retrying video load in ${retryInterval}ms (attempt ${retryCount.current + 1}/${maxRetries})`,
		);

		retryTimeout.current = setTimeout(() => {
			reloadVideo();
		}, retryInterval);
	}, [reloadVideo, maxRetries]);

	// Reset state when video source changes
	useEffect(() => {
		resolvedSrc.refetch();
		setVideoLoaded(false);
		setHasError(false);
		isRetryingRef.current = false;
		setIsRetrying(false);
		retryCount.current = 0;
		startTime.current = Date.now();

		if (retryTimeout.current) {
			clearTimeout(retryTimeout.current);
			retryTimeout.current = null;
		}
	}, [resolvedSrc.refetch, videoSrc, enableCrossOrigin]);

	// Track video duration for comment markers
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;

		const handleLoadedMetadata = () => {
			setDuration(video.duration);
		};

		video.addEventListener("loadedmetadata", handleLoadedMetadata);

		return () => {
			video.removeEventListener("loadedmetadata", handleLoadedMetadata);
		};
	}, [resolvedSrc.isLoading]);

	// Track when all data is ready for comment markers
	const [markersReady, setMarkersReady] = useState(false);
	const [hoveredComment, setHoveredComment] = useState<string | null>(null);

	// Memoize hover handlers to prevent render loops
	const handleMouseEnter = useCallback((commentId: string) => {
		setHoveredComment(commentId);
	}, []);

	const handleMouseLeave = useCallback(() => {
		setHoveredComment(null);
	}, []);

	useEffect(() => {
		// Only show markers when we have duration, comments, and video element
		if (duration > 0 && comments.length > 0 && videoRef.current) {
			setMarkersReady(true);
		}
	}, [duration, comments.length]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !resolvedSrc.isLoading) return;

		const handleLoadedData = () => {
			setVideoLoaded(true);
			setHasError(false);
			isRetryingRef.current = false;
			setIsRetrying(false);
			if (!hasPlayedOnce) {
				setShowPlayButton(true);
			}
			if (retryTimeout.current) {
				clearTimeout(retryTimeout.current);
				retryTimeout.current = null;
			}
		};

		const handleCanPlay = () => {
			setVideoLoaded(true);
			setHasError(false);
			isRetryingRef.current = false;
			setIsRetrying(false);
			if (retryTimeout.current) {
				clearTimeout(retryTimeout.current);
				retryTimeout.current = null;
			}
		};

		const handleLoad = () => {
			setVideoLoaded(true);
		};

		const handlePlay = () => {
			setHasPlayedOnce(true);
		};

		const handleError = (e: Event) => {
			const error = (e.target as HTMLVideoElement).error;
			console.error("CapVideoPlayer: Video error detected:", error);
			if (!videoLoaded && !hasError) {
				// Set both ref and state immediately to prevent any flash of error UI
				isRetryingRef.current = true;
				setIsRetrying(true);
				setHasError(false);
				setupRetry();
			}
		};

		// Caption track setup
		let captionTrack: TextTrack | null = null;

		const handleCueChange = (): void => {
			if (
				captionTrack &&
				captionTrack.activeCues &&
				captionTrack.activeCues.length > 0
			) {
				const cue = captionTrack.activeCues[0] as VTTCue;
				const plainText = cue.text.replace(/<[^>]*>/g, "");
				setCurrentCue(plainText);
			} else {
				setCurrentCue("");
			}
		};

		const setupTracks = (): void => {
			const tracks = Array.from(video.textTracks);

			for (const track of tracks) {
				if (track.kind === "captions" || track.kind === "subtitles") {
					captionTrack = track;
					track.mode = "hidden";
					track.addEventListener("cuechange", handleCueChange);
					break;
				}
			}
		};

		// Ensure all caption tracks remain hidden
		const ensureTracksHidden = (): void => {
			const tracks = Array.from(video.textTracks);
			for (const track of tracks) {
				if (track.kind === "captions" || track.kind === "subtitles") {
					if (track.mode !== "hidden") {
						track.mode = "hidden";
					}
				}
			}
		};

		const handleLoadedMetadataWithTracks = () => {
			setVideoLoaded(true);
			if (!hasPlayedOnce) {
				setShowPlayButton(true);
			}
			setupTracks();
		};

		// Monitor for track changes and ensure they stay hidden
		const handleTrackChange = () => {
			ensureTracksHidden();
		};

		video.addEventListener("loadeddata", handleLoadedData);
		video.addEventListener("canplay", handleCanPlay);
		video.addEventListener("loadedmetadata", handleLoadedMetadataWithTracks);
		video.addEventListener("load", handleLoad);
		video.addEventListener("play", handlePlay);
		video.addEventListener("error", handleError as EventListener);
		video.addEventListener("loadedmetadata", handleLoadedMetadataWithTracks);

		// Add event listeners to monitor track changes
		video.textTracks.addEventListener("change", handleTrackChange);
		video.textTracks.addEventListener("addtrack", handleTrackChange);
		video.textTracks.addEventListener("removetrack", handleTrackChange);

		if (video.readyState === 4) {
			handleLoadedData();
		}

		// Initial timeout to catch videos that take too long to load
		if (!videoLoaded && !hasError && retryCount.current === 0) {
			const initialTimeout = setTimeout(() => {
				if (!videoLoaded && !hasError) {
					console.log(
						"Video taking longer than expected to load, attempting reload",
					);
					isRetryingRef.current = true;
					setIsRetrying(true);
					setupRetry();
				}
			}, 10000);

			return () => {
				clearTimeout(initialTimeout);
				video.removeEventListener("loadeddata", handleLoadedData);
				video.removeEventListener("canplay", handleCanPlay);
				video.removeEventListener("load", handleLoad);
				video.removeEventListener("play", handlePlay);
				video.removeEventListener("error", handleError as EventListener);
				video.removeEventListener(
					"loadedmetadata",
					handleLoadedMetadataWithTracks,
				);
				video.textTracks.removeEventListener("change", handleTrackChange);
				video.textTracks.removeEventListener("addtrack", handleTrackChange);
				video.textTracks.removeEventListener("removetrack", handleTrackChange);
				if (retryTimeout.current) clearTimeout(retryTimeout.current);
			};
		}

		return () => {
			video.removeEventListener("loadeddata", handleLoadedData);
			video.removeEventListener("canplay", handleCanPlay);
			video.removeEventListener("load", handleLoad);
			video.removeEventListener("play", handlePlay);
			video.removeEventListener("error", handleError as EventListener);
			video.removeEventListener(
				"loadedmetadata",
				handleLoadedMetadataWithTracks,
			);
			video.textTracks.removeEventListener("change", handleTrackChange);
			video.textTracks.removeEventListener("addtrack", handleTrackChange);
			video.textTracks.removeEventListener("removetrack", handleTrackChange);
			if (retryTimeout.current) {
				clearTimeout(retryTimeout.current);
			}
			if (captionTrack) {
				captionTrack.removeEventListener("cuechange", handleCueChange);
			}
		};
	}, [hasPlayedOnce, videoSrc, resolvedSrc.isLoading]);

	const generateVideoFrameThumbnail = useCallback((time: number): string => {
		const video = videoRef.current;

		if (!video) {
			return `https://placeholder.pics/svg/224x128/1f2937/ffffff/Loading ${Math.floor(time)}s`;
		}

		const canvas = document.createElement("canvas");
		canvas.width = 224;
		canvas.height = 128;
		const ctx = canvas.getContext("2d");

		if (ctx) {
			try {
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
				return canvas.toDataURL("image/jpeg", 0.8);
			} catch (error) {
				return `https://placeholder.pics/svg/224x128/dc2626/ffffff/Error`;
			}
		}
		return `https://placeholder.pics/svg/224x128/dc2626/ffffff/Error`;
	}, []);

	const isUploadFailed = uploadProgress?.status === "failed";

	const prevUploadProgress = useRef<typeof uploadProgress>(uploadProgress);
	useEffect(() => {
		// Check if we transitioned from having upload progress to null which means it's completed and reload the video.
		// This prevents it just showing the dreaded "Format error" screen.
		if (prevUploadProgress.current && !uploadProgress && !videoLoaded) {
			reloadVideo();
			// Make it more reliable.
			setTimeout(() => reloadVideo(), 1000);
		}
		prevUploadProgress.current = uploadProgress;
	}, [uploadProgress, videoLoaded, reloadVideo]);

	return (
		<MediaPlayer
			onMouseEnter={() => setControlsVisible(true)}
			onMouseLeave={() => setControlsVisible(false)}
			onTouchStart={() => setControlsVisible(true)}
			onTouchEnd={() => setControlsVisible(false)}
			className={clsx(
				mediaPlayerClassName,
				"[&::-webkit-media-text-track-display]:!hidden",
			)}
			autoHide
		>
			{isUploadFailed && (
				<div className="flex absolute inset-0 flex-col px-3 gap-3 z-[20] justify-center items-center bg-black transition-opacity duration-300">
					<AlertTriangleIcon className="text-red-500 size-12" />
					<p className="text-gray-11 text-sm leading-relaxed text-center text-balance w-full max-w-[340px] mx-auto">
						Upload failed. Please try re-uploading from the Cap desktop app via
						Settings {">"} Previous Recordings.
					</p>
				</div>
			)}
			<div
				className={clsx(
					"flex absolute inset-0 z-10 justify-center items-center bg-black transition-opacity duration-300",
					videoLoaded || !!uploadProgress
						? "opacity-0 pointer-events-none"
						: "opacity-100",
				)}
			>
				<div className="flex flex-col gap-2 items-center">
					<LogoSpinner className="w-8 h-auto animate-spin sm:w-10" />
					{retryCount.current > 0 && (
						<p className="text-sm text-white opacity-75">
							Preparing video... ({retryCount.current}/{maxRetries})
						</p>
					)}
				</div>
			</div>
			{resolvedSrc.isSuccess && (
				<MediaPlayerVideo
					src={resolvedSrc.data.url}
					ref={videoRef}
					onLoadedData={() => {
						setVideoLoaded(true);
					}}
					onPlay={() => {
						setShowPlayButton(false);
						setHasPlayedOnce(true);
					}}
					crossOrigin={
						resolvedSrc.data.supportsCrossOrigin ? "anonymous" : undefined
					}
					playsInline
					autoPlay={autoplay}
				>
					{chaptersSrc && <track default kind="chapters" src={chaptersSrc} />}
					{captionsSrc && (
						<track
							label="English"
							kind="captions"
							srcLang="en"
							src={captionsSrc}
						/>
					)}
				</MediaPlayerVideo>
			)}
			<AnimatePresence>
				{!videoLoaded && isUploading && !isUploadFailed && (
					<motion.div
						initial={{ opacity: 0, y: 10 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: 10 }}
						transition={{ duration: 0.2 }}
						className="flex absolute inset-0 z-10 justify-center items-center m-auto size-[130px] md:size-32"
					>
						<ProgressCircle
							progress={
								uploadProgress?.status === "uploading"
									? uploadProgress.progress
									: 0
							}
						/>
					</motion.div>
				)}
				{showPlayButton &&
					videoLoaded &&
					!hasPlayedOnce &&
					!isUploading &&
					!isUploadFailed && (
						<motion.div
							whileHover={{ scale: 1.1 }}
							whileTap={{ scale: 0.9 }}
							initial={{ opacity: 0, y: 10 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 10 }}
							transition={{ duration: 0.2 }}
							onClick={() => videoRef.current?.play()}
							className="flex absolute inset-0 z-10 justify-center items-center m-auto bg-blue-500 rounded-full transition-colors transform cursor-pointer hover:bg-blue-600 size-12 xs:size-20 md:size-32"
						>
							<FontAwesomeIcon
								icon={faPlay}
								className="text-white size-4 xs:size-8 md:size-12"
							/>
						</motion.div>
					)}
			</AnimatePresence>
			{currentCue && toggleCaptions && (
				<div
					className={clsx(
						"absolute left-1/2 transform -translate-x-1/2 text-sm sm:text-xl z-40 pointer-events-none bg-black/80 text-white px-3 sm:px-4 py-1.5 sm:py-2 rounded-md text-center transition-all duration-300 ease-in-out",
						"max-w-[90%] sm:max-w-[480px] md:max-w-[600px]",
						controlsVisible || videoRef.current?.paused
							? "bottom-16 sm:bottom-24"
							: "bottom-3 sm:bottom-12",
					)}
				>
					{currentCue}
				</div>
			)}
			<MediaPlayerLoading />
			{!isRetrying && !isRetryingRef.current && !isUploading && (
				<MediaPlayerError />
			)}
			<MediaPlayerVolumeIndicator />

			{mainControlsVisible &&
				markersReady &&
				(() => {
					const filteredComments = comments.filter(
						(comment) =>
							comment &&
							comment.timestamp !== null &&
							comment.id &&
							!(disableCommentStamps && comment.type === "text") &&
							!(disableReactionStamps && comment.type === "emoji"),
					);

					return filteredComments.map((comment) => {
						const position = (Number(comment.timestamp) / duration) * 100;
						const containerPadding = 20;
						const availableWidth = `calc(100% - ${containerPadding * 2}px)`;
						const adjustedPosition = `calc(${containerPadding}px + (${position}% * ${availableWidth} / 100%))`;

						return (
							<CommentStamp
								key={comment.id}
								comment={comment}
								adjustedPosition={adjustedPosition}
								handleMouseEnter={handleMouseEnter}
								handleMouseLeave={handleMouseLeave}
								onSeek={onSeek}
								hoveredComment={hoveredComment}
							/>
						);
					});
				})()}

			<MediaPlayerControls
				className="flex-col items-start gap-2.5"
				mainControlsVisible={(arg: boolean) => setMainControlsVisible(arg)}
				isUploadingOrFailed={isUploading || isUploadFailed}
			>
				<MediaPlayerControlsOverlay />
				<MediaPlayerSeek
					tooltipThumbnailSrc={
						isMobile || !resolvedSrc.isSuccess
							? undefined
							: generateVideoFrameThumbnail
					}
				/>
				<div className="flex gap-2 items-center w-full">
					<div className="flex flex-1 gap-2 items-center">
						<MediaPlayerPlay />
						<MediaPlayerSeekBackward />
						<MediaPlayerSeekForward />
						<MediaPlayerVolume expandable />
						<MediaPlayerTime />
					</div>
					<div className="flex gap-2 items-center">
						{!disableCaptions && (
							<MediaPlayerCaptions
								setToggleCaptions={setToggleCaptions}
								toggleCaptions={toggleCaptions}
							/>
						)}
						<MediaPlayerSettings />
						<MediaPlayerPiP />
						<MediaPlayerFullscreen />
					</div>
				</div>
			</MediaPlayerControls>
		</MediaPlayer>
	);
}

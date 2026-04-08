"use client";

import { LogoSpinner } from "@cap/ui";
import { calculateStrokeDashoffset, getProgressCircleConfig } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { faPlay } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import Hls from "hls.js";
import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { retryVideoProcessing } from "@/actions/video/retry-processing";
import {
	canRetryFailedProcessing,
	getUploadFailureMessage,
	shouldReloadPlaybackAfterUploadCompletes,
	useUploadProgress,
} from "./ProgressCircle";

const { circumference } = getProgressCircleConfig();

function getProgressStatusText(
	status: "uploading" | "processing" | "generating_thumbnail",
) {
	switch (status) {
		case "processing":
			return "Processing";
		case "generating_thumbnail":
			return "Finishing up";
		default:
			return "Uploading";
	}
}

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

type EnhancedAudioStatus = "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";

interface CaptionOption {
	code: string;
	name: string;
}

interface Props {
	videoSrc: string;
	videoId: Video.VideoId;
	chaptersSrc: string;
	captionsSrc: string;
	videoRef: React.RefObject<HTMLVideoElement | null>;
	mediaPlayerClassName?: string;
	disableCaptions?: boolean;
	autoplay?: boolean;
	hasActiveUpload?: boolean;
	isLiveSegments?: boolean;
	enhancedAudioUrl?: string | null;
	enhancedAudioStatus?: EnhancedAudioStatus | null;
	captionLanguage?: string;
	onCaptionLanguageChange?: (language: string) => void;
	availableCaptions?: CaptionOption[];
	isCaptionLoading?: boolean;
	hasCaptions?: boolean;
	canRetryProcessing?: boolean;
	duration?: number | null;
}

export function HLSVideoPlayer({
	videoSrc,
	videoId,
	chaptersSrc,
	captionsSrc,
	videoRef,
	mediaPlayerClassName,
	autoplay = false,
	hasActiveUpload,
	isLiveSegments = false,
	disableCaptions,
	enhancedAudioUrl: _enhancedAudioUrl,
	enhancedAudioStatus: _enhancedAudioStatus,
	captionLanguage,
	onCaptionLanguageChange,
	availableCaptions = [],
	isCaptionLoading = false,
	hasCaptions = false,
	canRetryProcessing = false,
	duration: fallbackDuration,
}: Props) {
	const hlsInstance = useRef<Hls | null>(null);
	const [currentCue, setCurrentCue] = useState<string>("");
	const [controlsVisible, setControlsVisible] = useState(false);
	const [toggleCaptions, setToggleCaptions] = useState(true);
	const [showPlayButton, setShowPlayButton] = useState(false);
	const [videoLoaded, setVideoLoaded] = useState(false);
	const [hlsInitFailed, setHlsInitFailed] = useState(false);
	const [hasPlayedOnce, setHasPlayedOnce] = useState(false);
	const hasPlayedOnceRef = useRef(false);
	const [isRetryingProcessing, setIsRetryingProcessing] = useState(false);
	const [sourceVersion, setSourceVersion] = useState(0);
	const [playerDuration, setPlayerDuration] = useState(fallbackDuration ?? 0);
	const queryClient = useQueryClient();
	const playbackSrc =
		sourceVersion === 0
			? videoSrc
			: videoSrc.includes("?")
				? `${videoSrc}&_t=${sourceVersion}`
				: `${videoSrc}?_t=${sourceVersion}`;
	const reloadPlayback = useCallback(() => {
		setVideoLoaded(false);
		setSourceVersion((current) => current + 1);
	}, []);

	useEffect(() => {
		setPlayerDuration(fallbackDuration ?? 0);
	}, [fallbackDuration]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;

		const handleLoadedData = () => {
			setVideoLoaded(true);
			if (!hasPlayedOnceRef.current) {
				setShowPlayButton(true);
			}
		};

		const handleCanPlay = () => {
			setVideoLoaded(true);
			if (!hasPlayedOnceRef.current) {
				setShowPlayButton(true);
			}
		};

		const handleLoad = () => {
			setVideoLoaded(true);
			if (!hasPlayedOnceRef.current) {
				setShowPlayButton(true);
			}
		};

		const handlePlay = () => {
			setShowPlayButton(false);
			setHasPlayedOnce(true);
			hasPlayedOnceRef.current = true;
		};

		const handleLoadedMetadata = () => {
			if (Number.isFinite(video.duration) && video.duration > 0) {
				setPlayerDuration(video.duration);
			}
		};

		const handleError = (e: Event) => {
			const error = (e.target as HTMLVideoElement).error;
			console.error("HLSVideoPlayer: Video error detected:", {
				error,
				code: error?.code,
				message: error?.message,
				videoSrc: playbackSrc,
			});
		};

		video.addEventListener("loadeddata", handleLoadedData);
		video.addEventListener("loadedmetadata", handleLoadedMetadata);
		video.addEventListener("canplay", handleCanPlay);
		video.addEventListener("load", handleLoad);
		video.addEventListener("play", handlePlay);
		video.addEventListener("error", handleError);

		if (Number.isFinite(video.duration) && video.duration > 0) {
			setPlayerDuration(video.duration);
		}

		if (video.readyState >= 2) {
			setVideoLoaded(true);
			if (!hasPlayedOnceRef.current) {
				setShowPlayButton(true);
			}
		}

		return () => {
			video.removeEventListener("loadeddata", handleLoadedData);
			video.removeEventListener("loadedmetadata", handleLoadedMetadata);
			video.removeEventListener("canplay", handleCanPlay);
			video.removeEventListener("load", handleLoad);
			video.removeEventListener("play", handlePlay);
			video.removeEventListener("error", handleError);
		};
	}, [playbackSrc, videoRef.current]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !playbackSrc) return;

		setHlsInitFailed(false);

		if (Hls.isSupported()) {
			const hls = new Hls({
				enableWorker: true,
				lowLatencyMode: false,
				backBufferLength: 90,
				...(isLiveSegments
					? {
							liveSyncDurationCount: 3,
							liveMaxLatencyDurationCount: 6,
							manifestLoadingRetryDelay: 2000,
							manifestLoadingMaxRetry: 30,
							levelLoadingRetryDelay: 2000,
							levelLoadingMaxRetry: 30,
						}
					: {}),
			});

			hlsInstance.current = hls;

			hls.loadSource(playbackSrc);
			hls.attachMedia(video);

			hls.on(Hls.Events.MANIFEST_PARSED, () => {
				console.log("HLSVideoPlayer: HLS manifest parsed successfully");
				setVideoLoaded(true);
				if (!hasPlayedOnceRef.current) {
					setShowPlayButton(true);
				}
			});

			let networkRetryCount = 0;
			const maxNetworkRetries = isLiveSegments ? 30 : 6;
			let hasTriedPlaylistReload = false;

			hls.on(Hls.Events.ERROR, (event, data) => {
				console.error("HLSVideoPlayer: HLS error:", event, data);

				const isExpiredUrl =
					data.response?.code === 403 || data.response?.code === 410;
				if (
					!data.fatal &&
					isExpiredUrl &&
					(data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
						data.details === Hls.ErrorDetails.KEY_LOAD_ERROR) &&
					!hasTriedPlaylistReload
				) {
					hasTriedPlaylistReload = true;
					console.log(
						"HLSVideoPlayer: Presigned URL expired, reloading playlist for fresh URLs",
					);
					hls.loadSource(playbackSrc);
					return;
				}

				if (data.fatal) {
					switch (data.type) {
						case Hls.ErrorTypes.NETWORK_ERROR:
							networkRetryCount++;
							if (networkRetryCount <= maxNetworkRetries) {
								const delay = isLiveSegments ? 2000 : 1000;
								console.log(
									`HLSVideoPlayer: Fatal network error, retrying in ${delay}ms (attempt ${networkRetryCount}/${maxNetworkRetries})`,
								);
								setTimeout(() => hls.startLoad(), delay);
							} else {
								console.log("HLSVideoPlayer: Network retries exhausted");
								setHlsInitFailed(true);
								hls.destroy();
							}
							break;
						case Hls.ErrorTypes.MEDIA_ERROR:
							console.log(
								"HLSVideoPlayer: Fatal media error encountered, trying to recover",
							);
							hls.recoverMediaError();
							break;
						default:
							console.log("HLSVideoPlayer: Fatal error, cannot recover");
							setHlsInitFailed(true);
							hls.destroy();
							break;
					}
				}
			});

			hls.on(Hls.Events.MANIFEST_LOADED, () => {
				networkRetryCount = 0;
				hasTriedPlaylistReload = false;
			});

			return () => {
				if (hlsInstance.current) {
					hlsInstance.current.destroy();
					hlsInstance.current = null;
				}
			};
		} else if (video.canPlayType("application/vnd.apple.mpegurl")) {
			video.src = playbackSrc;
			video.load();
			console.log("HLSVideoPlayer: Using native HLS support");
		} else {
			console.error("HLSVideoPlayer: HLS is not supported in this browser");
			setHlsInitFailed(true);
		}
	}, [playbackSrc, isLiveSegments, videoRef.current]);

	// Caption handling
	useEffect(() => {
		const video = videoRef.current;
		if (!video || !captionsSrc) return;

		let captionTrack: TextTrack | null = null;

		const handleCueChange = (): void => {
			if (captionTrack?.activeCues && captionTrack.activeCues.length > 0) {
				const activeCue = captionTrack.activeCues[0] as VTTCue;
				setCurrentCue(activeCue.text);
			} else {
				setCurrentCue("");
			}
		};

		const setupTracks = (): void => {
			const tracks = video.textTracks;
			for (let i = 0; i < tracks.length; i++) {
				const track = tracks[i];
				if (
					track &&
					(track.kind === "captions" || track.kind === "subtitles")
				) {
					captionTrack = track;
					track.mode = "hidden";
					track.addEventListener("cuechange", handleCueChange);
					break;
				}
			}
		};

		// Ensure all caption tracks remain hidden
		const ensureTracksHidden = (): void => {
			const tracks = video.textTracks;
			for (let i = 0; i < tracks.length; i++) {
				const track = tracks[i];
				if (
					track &&
					(track.kind === "captions" || track.kind === "subtitles")
				) {
					if (track.mode !== "hidden") {
						track.mode = "hidden";
					}
				}
			}
		};

		const handleLoadedMetadata = (): void => {
			setupTracks();
		};

		const handleTrackChange = () => {
			ensureTracksHidden();
			setupTracks();
		};

		video.addEventListener("loadedmetadata", handleLoadedMetadata);

		// Add event listeners to monitor track changes
		video.textTracks.addEventListener("change", handleTrackChange);
		video.textTracks.addEventListener("addtrack", handleTrackChange);
		video.textTracks.addEventListener("removetrack", handleTrackChange);

		if (video.readyState >= 1) {
			setupTracks();
		}

		return () => {
			video.removeEventListener("loadedmetadata", handleLoadedMetadata);
			video.textTracks.removeEventListener("change", handleTrackChange);
			video.textTracks.removeEventListener("addtrack", handleTrackChange);
			video.textTracks.removeEventListener("removetrack", handleTrackChange);
			if (captionTrack) {
				captionTrack.removeEventListener("cuechange", handleCueChange);
			}
		};
	}, [captionsSrc, videoRef.current]);

	const uploadProgressRaw = useUploadProgress(
		videoId,
		hasActiveUpload || false,
	);
	const isErrorWhileHlsLoading =
		!videoLoaded &&
		!hlsInitFailed &&
		(uploadProgressRaw?.status === "error" ||
			uploadProgressRaw?.status === "failed");
	const uploadProgress =
		videoLoaded || isErrorWhileHlsLoading ? null : uploadProgressRaw;
	const isUploading = uploadProgress?.status === "uploading";
	const isProcessing = uploadProgress?.status === "processing";
	const isGeneratingThumbnail =
		uploadProgress?.status === "generating_thumbnail";
	const isUploadFailed = uploadProgress?.status === "failed";
	const isUploadError = uploadProgress?.status === "error";
	const hasFailedOrError = isUploadFailed || isUploadError;
	const hasActiveProgress =
		isUploading || isProcessing || isGeneratingThumbnail;
	const canRetryUploadProcessing = canRetryFailedProcessing(
		uploadProgress,
		canRetryProcessing,
	);
	const uploadFailureMessage = getUploadFailureMessage(
		uploadProgress,
		canRetryProcessing,
	);

	const retryProcessing = async () => {
		if (!canRetryUploadProcessing || isRetryingProcessing) {
			return;
		}

		setIsRetryingProcessing(true);

		try {
			const result = await retryVideoProcessing({ videoId });
			await queryClient.invalidateQueries({
				queryKey: ["getUploadProgress", videoId],
			});
			toast.success(
				result.status === "started"
					? "Video processing restarted."
					: "Video is still processing.",
			);
		} catch (error) {
			console.error("Failed to retry video processing", error);
			toast.error("Could not retry video processing.");
		} finally {
			setIsRetryingProcessing(false);
		}
	};

	const prevUploadProgress = useRef<typeof uploadProgress>(uploadProgress);
	useEffect(() => {
		if (
			shouldReloadPlaybackAfterUploadCompletes(
				prevUploadProgress.current,
				uploadProgress,
				videoLoaded,
			)
		) {
			reloadPlayback();
			setTimeout(reloadPlayback, 1000);
		}
		prevUploadProgress.current = uploadProgress;
	}, [uploadProgress, videoLoaded, reloadPlayback]);

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
			{hasFailedOrError && (
				<div className="flex absolute inset-0 flex-col px-3 gap-3 z-[20] justify-center items-center bg-black transition-opacity duration-300">
					<AlertTriangleIcon className="text-red-500 size-12" />
					<p className="text-gray-11 text-sm leading-relaxed text-center text-balance w-full max-w-[340px] mx-auto">
						{uploadFailureMessage}
					</p>
					{canRetryUploadProcessing && (
						<button
							type="button"
							onClick={retryProcessing}
							disabled={isRetryingProcessing}
							className="px-4 py-2 text-sm font-medium text-white bg-blue-500 rounded-full transition-colors disabled:opacity-60 disabled:cursor-not-allowed hover:bg-blue-600"
						>
							{isRetryingProcessing ? "Retrying..." : "Retry Processing"}
						</button>
					)}
				</div>
			)}
			<div
				className={clsx(
					"flex absolute inset-0 z-10 justify-center items-center bg-black transition-opacity duration-300",
					videoLoaded || hasActiveProgress || hasFailedOrError
						? "opacity-0 pointer-events-none"
						: "opacity-100",
				)}
			>
				<div className="flex flex-col gap-2 items-center">
					<LogoSpinner className="w-8 h-auto animate-spin sm:w-10" />
				</div>
			</div>
			<AnimatePresence>
				{!videoLoaded && hasActiveProgress && (
					<>
						<motion.div
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.2 }}
							className="absolute inset-0 z-10 transition-all duration-300 bg-black/60 rounded-xl"
						/>
						<motion.div
							initial={{ opacity: 0, y: 10 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 10 }}
							transition={{ duration: 0.2 }}
							className="flex absolute bottom-3 left-3 gap-2 items-center z-20"
						>
							<span className="text-sm font-semibold text-white">
								{getProgressStatusText(
									isProcessing
										? "processing"
										: isGeneratingThumbnail
											? "generating_thumbnail"
											: "uploading",
								)}
								{uploadProgress?.progress != null &&
									uploadProgress.progress > 0 &&
									` ${Math.round(uploadProgress.progress)}%`}
							</span>
							<svg className="w-4 h-4 transform -rotate-90" viewBox="0 0 20 20">
								<title>Progress</title>
								<circle
									cx="10"
									cy="10"
									r="8"
									stroke="currentColor"
									strokeWidth="3"
									fill="none"
									className="text-white/30"
								/>
								<circle
									cx="10"
									cy="10"
									r="8"
									stroke="currentColor"
									strokeWidth="3"
									fill="none"
									strokeLinecap="round"
									className="text-white transition-all duration-200 ease-out"
									style={{
										strokeDasharray: `${circumference} ${circumference}`,
										strokeDashoffset: `${calculateStrokeDashoffset(uploadProgress?.progress ?? 0, circumference)}`,
									}}
								/>
							</svg>
						</motion.div>
					</>
				)}
				{showPlayButton &&
					videoLoaded &&
					!hasPlayedOnce &&
					!hasActiveProgress && (
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
			<MediaPlayerVideo
				src={undefined} // HLS source is handled by HLS.js
				ref={videoRef}
				onPlay={() => {
					setShowPlayButton(false);
					setHasPlayedOnce(true);
					hasPlayedOnceRef.current = true;
				}}
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
			{currentCue && toggleCaptions && (
				<div
					className={clsx(
						"absolute left-1/2 transform -translate-x-1/2 text-sm sm:text-xl z-40 pointer-events-none bg-black/80 text-white px-3 sm:px-4 py-1.5 sm:py-2 rounded-md text-center transition-all duration-300 ease-in-out",
						"max-w-[90%] sm:max-w-[480px] md:max-w-[600px]",
						controlsVisible || videoRef.current?.paused
							? "bottom-16 sm:bottom-20"
							: "bottom-3 sm:bottom-12",
					)}
				>
					{currentCue}
				</div>
			)}
			<MediaPlayerLoading />
			<MediaPlayerError />
			<MediaPlayerVolumeIndicator />
			<MediaPlayerControls
				className="flex-col items-start gap-2.5"
				isUploadingOrFailed={hasActiveProgress || hasFailedOrError}
			>
				<MediaPlayerControlsOverlay />
				<MediaPlayerSeek fallbackDuration={playerDuration} />
				<div className="flex gap-2 items-center w-full">
					<div className="flex flex-1 gap-2 items-center">
						<MediaPlayerPlay />
						<MediaPlayerSeekBackward />
						<MediaPlayerSeekForward />
						<MediaPlayerVolume
							expandable
							// enhancedAudioEnabled={enhancedAudioEnabled}
							// enhancedAudioMuted={enhancedAudioMuted}
							// setEnhancedAudioMuted={setEnhancedAudioMuted}
						/>
						<MediaPlayerTime fallbackDuration={playerDuration} />
					</div>
					<div className="flex gap-2 items-center">
						{!disableCaptions && (
							<MediaPlayerCaptions
								setToggleCaptions={setToggleCaptions}
								toggleCaptions={toggleCaptions}
							/>
						)}
						{/* <MediaPlayerEnhancedAudio
							enhancedAudioStatus={enhancedAudioStatus}
							enhancedAudioEnabled={enhancedAudioEnabled}
							setEnhancedAudioEnabled={setEnhancedAudioEnabled}
						/> */}
						<MediaPlayerSettings
							// enhancedAudioStatus={enhancedAudioStatus}
							// enhancedAudioEnabled={enhancedAudioEnabled}
							// setEnhancedAudioEnabled={setEnhancedAudioEnabled}
							captionLanguage={captionLanguage}
							onCaptionLanguageChange={onCaptionLanguageChange}
							availableCaptions={availableCaptions}
							isCaptionLoading={isCaptionLoading}
							hasCaptions={hasCaptions}
						/>
						<MediaPlayerPiP />
						<MediaPlayerFullscreen />
					</div>
				</div>
			</MediaPlayerControls>
			{/* {enhancedAudioUrl && (
				<>
					<audio
						ref={enhancedAudioRef}
						src={enhancedAudioUrl}
						preload="auto"
						className="hidden"
					>
						<track kind="captions" />
					</audio>
					<EnhancedAudioSync
						enhancedAudioRef={enhancedAudioRef}
						videoRef={videoRef}
						enhancedAudioEnabled={enhancedAudioEnabled}
						enhancedAudioMuted={enhancedAudioMuted}
					/>
				</>
			)} */}
		</MediaPlayer>
	);
}

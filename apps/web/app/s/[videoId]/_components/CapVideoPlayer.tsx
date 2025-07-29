"use client"

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
import { useEffect, useCallback, useState, useRef } from "react";
import clsx from "clsx";
import { faPlay } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AnimatePresence, motion } from "framer-motion";
import { LogoSpinner } from "@cap/ui";

interface Props {
  videoSrc: string;
  chaptersSrc: string;
  captionsSrc: string;
  videoRef: React.RefObject<HTMLVideoElement>;
  mediaPlayerClassName?: string;
  autoplay?: boolean;
  enableCrossOrigin?: boolean;
}

export function CapVideoPlayer({
  videoSrc,
  chaptersSrc,
  captionsSrc,
  videoRef,
  mediaPlayerClassName,
  autoplay = false,
  enableCrossOrigin = false,
}: Props) {

  const [currentCue, setCurrentCue] = useState<string>('');
  const [controlsVisible, setControlsVisible] = useState(false);
  const [toggleCaptions, setToggleCaptions] = useState(true);
  const [showPlayButton, setShowPlayButton] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [hasPlayedOnce, setHasPlayedOnce] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [resolvedVideoSrc, setResolvedVideoSrc] = useState<string>(videoSrc);
  const [useCrossOrigin, setUseCrossOrigin] = useState(enableCrossOrigin);
  const [urlResolved, setUrlResolved] = useState(false);
  const retryCount = useRef(0);
  const retryTimeout = useRef<NodeJS.Timeout | null>(null);
  const startTime = useRef<number>(Date.now());
  const [hasError, setHasError] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const isRetryingRef = useRef(false);
  const maxRetries = 3;

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 640);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const fetchNewUrl = useCallback(async () => {
    try {
      const timestamp = new Date().getTime();
      const urlWithTimestamp = videoSrc.includes("?")
        ? `${videoSrc}&_t=${timestamp}`
        : `${videoSrc}?_t=${timestamp}`;

      const response = await fetch(urlWithTimestamp, { method: "HEAD" });
      const finalUrl = response.redirected ? response.url : urlWithTimestamp;

      // Check if the resolved URL is from a CORS-incompatible service
      const isCloudflareR2 = finalUrl.includes('.r2.cloudflarestorage.com');
      const isS3 = finalUrl.includes('.s3.') || finalUrl.includes('amazonaws.com');
      const isCorsIncompatible = isCloudflareR2 || isS3;

      // Set CORS based on URL compatibility BEFORE video element is created
      if (isCorsIncompatible) {
        console.log('CapVideoPlayer: Detected CORS-incompatible URL, disabling crossOrigin:', finalUrl);
        setUseCrossOrigin(false);
      } else {
        setUseCrossOrigin(enableCrossOrigin);
      }

      setResolvedVideoSrc(finalUrl);
      setUrlResolved(true);
      return finalUrl;
    } catch (error) {
      console.error("CapVideoPlayer: Error fetching new video URL:", error);
      const timestamp = new Date().getTime();
      const fallbackUrl = videoSrc.includes("?")
        ? `${videoSrc}&_t=${timestamp}`
        : `${videoSrc}?_t=${timestamp}`;
      setResolvedVideoSrc(fallbackUrl);
      setUrlResolved(true);
      return fallbackUrl;
    }
  }, [videoSrc, enableCrossOrigin]);

  const reloadVideo = useCallback(async () => {
    const video = videoRef.current;
    if (!video || retryCount.current >= maxRetries) return;

    console.log(
      `Reloading video (attempt ${retryCount.current + 1}/${maxRetries})`
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
  }, [fetchNewUrl, maxRetries]);

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

    console.log(`Retrying video load in ${retryInterval}ms (attempt ${retryCount.current + 1}/${maxRetries})`);
    
    retryTimeout.current = setTimeout(() => {
      reloadVideo();
    }, retryInterval);
  }, [reloadVideo, maxRetries]);

  // Reset state when video source changes
  useEffect(() => {
    setResolvedVideoSrc(videoSrc);
    setVideoLoaded(false);
    setHasError(false);
    isRetryingRef.current = false;
    setIsRetrying(false);
    retryCount.current = 0;
    startTime.current = Date.now();
    setUrlResolved(false);
    setUseCrossOrigin(enableCrossOrigin);

    if (retryTimeout.current) {
      clearTimeout(retryTimeout.current);
      retryTimeout.current = null;
    }
  }, [videoSrc, enableCrossOrigin]);

  // Resolve video URL on mount and when videoSrc changes
  useEffect(() => {
    fetchNewUrl();
  }, [fetchNewUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !urlResolved) return;

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
      console.error('CapVideoPlayer: Video error detected:', error);
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
      if (captionTrack && captionTrack.activeCues && captionTrack.activeCues.length > 0) {
        const cue = captionTrack.activeCues[0] as VTTCue;
        const plainText = cue.text.replace(/<[^>]*>/g, '');
        setCurrentCue(plainText);
      } else {
        setCurrentCue('');
      }
    };

    const setupTracks = (): void => {
      const tracks = Array.from(video.textTracks);

      for (const track of tracks) {
        if (track.kind === 'captions' || track.kind === 'subtitles') {
          captionTrack = track;
          track.mode = 'hidden';
          track.addEventListener('cuechange', handleCueChange);
          break;
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

    video.addEventListener('loadeddata', handleLoadedData);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('loadedmetadata', handleLoadedMetadataWithTracks);
    video.addEventListener('load', handleLoad);
    video.addEventListener('play', handlePlay);
    video.addEventListener('error', handleError as EventListener);
    video.addEventListener('loadedmetadata', handleLoadedMetadataWithTracks);

    if (video.readyState === 4) {
      handleLoadedData();
    }

    // Initial timeout to catch videos that take too long to load
    if (!videoLoaded && !hasError && retryCount.current === 0) {
      const initialTimeout = setTimeout(() => {
        if (!videoLoaded && !hasError) {
          console.log(
            "Video taking longer than expected to load, attempting reload"
          );
          isRetryingRef.current = true;
          setIsRetrying(true);
          setupRetry();
        }
      }, 10000);

      return () => {
        clearTimeout(initialTimeout);
        video.removeEventListener('loadeddata', handleLoadedData);
        video.removeEventListener('canplay', handleCanPlay);
        video.removeEventListener('load', handleLoad);
        video.removeEventListener('play', handlePlay);
        video.removeEventListener('error', handleError as EventListener);
        video.removeEventListener('loadedmetadata', handleLoadedMetadataWithTracks);
        if (retryTimeout.current) {
          clearTimeout(retryTimeout.current);
        }
      };
    }

    return () => {
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('load', handleLoad);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('error', handleError as EventListener);
      video.removeEventListener('loadedmetadata', handleLoadedMetadataWithTracks);
      if (retryTimeout.current) {
        clearTimeout(retryTimeout.current);
      }
      if (captionTrack) {
        captionTrack.removeEventListener('cuechange', handleCueChange);
      }
    };
  }, [hasPlayedOnce, videoSrc, urlResolved]);


  const generateVideoFrameThumbnail = useCallback((time: number): string => {
    const video = videoRef.current;

    if (!video) {
      return `https://placeholder.pics/svg/224x128/1f2937/ffffff/Loading ${Math.floor(time)}s`;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 224;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.8);
      } catch (error) {
        return `https://placeholder.pics/svg/224x128/dc2626/ffffff/Error`;
      }
    }
    return `https://placeholder.pics/svg/224x128/dc2626/ffffff/Error`;
  }, []);



  return (
    <>
      <MediaPlayer
        onMouseEnter={() => setControlsVisible(true)}
        onMouseLeave={() => setControlsVisible(false)}
        onTouchStart={() => setControlsVisible(true)}
        onTouchEnd={() => setControlsVisible(false)}
        className={clsx(mediaPlayerClassName, "[&::-webkit-media-text-track-display]:!hidden")} autoHide>
        <div
          className={clsx("flex absolute inset-0 z-10 justify-center items-center bg-black transition-opacity duration-300", videoLoaded ? "opacity-0 pointer-events-none" : "opacity-100")}
        >
          <div className="flex flex-col items-center gap-2">
            <LogoSpinner className="w-8 h-auto animate-spin sm:w-10" />
            {retryCount.current > 0 && (
              <p className="text-white text-sm opacity-75">
                Preparing video... ({retryCount.current}/{maxRetries})
              </p>
            )}
          </div>
        </div>
        {urlResolved && (
          <MediaPlayerVideo
            src={resolvedVideoSrc}
            ref={videoRef}
            onLoadedData={() => {
              setVideoLoaded(true);
            }}
            onPlay={() => {
              setShowPlayButton(false);
              setHasPlayedOnce(true);
            }}
            crossOrigin={useCrossOrigin ? "anonymous" : undefined}
            playsInline
            autoPlay={autoplay}
          >
            <track
              default
              kind="chapters"
              src={chaptersSrc}
            />
            <track
              label="English"
              kind="captions"
              srcLang="en"
              src={captionsSrc}
              default
            />
          </MediaPlayerVideo>
        )}
        <AnimatePresence>
          {showPlayButton && videoLoaded && !hasPlayedOnce && (
            <motion.div
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.2 }}
              onClick={() => videoRef.current?.play()}
              className="flex absolute inset-0 z-10 justify-center items-center m-auto bg-blue-500 rounded-full transition-colors transform cursor-pointer hover:bg-blue-600 size-12 xs:size-20 md:size-32">
              <FontAwesomeIcon icon={faPlay} className="text-white size-4 xs:size-8 md:size-12" />
            </motion.div>
          )}
        </AnimatePresence>
        {currentCue && toggleCaptions && (
          <div
            className={clsx(
              "absolute left-1/2 transform -translate-x-1/2 text-sm sm:text-xl z-40 pointer-events-none bg-black/80 text-white px-3 sm:px-4 py-1.5 sm:py-2 rounded-md text-center transition-all duration-300 ease-in-out",
              "max-w-[90%] sm:max-w-[480px] md:max-w-[600px]",
              controlsVisible || videoRef.current?.paused ? 'bottom-16 sm:bottom-20' : 'bottom-3 sm:bottom-12'
            )}
          >
            {currentCue}
          </div>
        )}
        <MediaPlayerLoading />
        {!isRetrying && !isRetryingRef.current && <MediaPlayerError />}
        <MediaPlayerVolumeIndicator />
        <MediaPlayerControls className="flex-col items-start gap-2.5">
          <MediaPlayerControlsOverlay />
          <MediaPlayerSeek tooltipThumbnailSrc={isMobile || !useCrossOrigin ? undefined : generateVideoFrameThumbnail} />
          <div className="flex gap-2 items-center w-full">
            <div className="flex flex-1 gap-2 items-center">
              <MediaPlayerPlay />
              <MediaPlayerSeekBackward />
              <MediaPlayerSeekForward />
              <MediaPlayerVolume expandable />
              <MediaPlayerTime />
            </div>
            <div className="flex gap-2 items-center">
              <MediaPlayerCaptions setToggleCaptions={setToggleCaptions} toggleCaptions={toggleCaptions} />
              <MediaPlayerSettings />
              <MediaPlayerPiP />
              <MediaPlayerFullscreen />
            </div>
          </div>
        </MediaPlayerControls>
      </MediaPlayer>
    </>
  );
}

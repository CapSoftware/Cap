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

const RETRY_INTERVALS = [2000, 5000, 10000];

export function CapVideoPlayer({
  videoSrc,
  chaptersSrc,
  captionsSrc,
  videoRef,
  mediaPlayerClassName,
  autoplay = false,
  enableCrossOrigin = false,
}: Props) {
  // Core video states
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [hasPlayedOnce, setHasPlayedOnce] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [urlResolved, setUrlResolved] = useState(false);
  const [resolvedVideoSrc, setResolvedVideoSrc] = useState<string>(videoSrc);
  const [useCrossOrigin, setUseCrossOrigin] = useState(enableCrossOrigin);

  // UI states (optimized to prevent unnecessary re-renders)
  const [isMobile, setIsMobile] = useState(false);

  // Caption state using ref to avoid re-renders during seeking
  const currentCueRef = useRef<string>('');
  const [currentCue, setCurrentCue] = useState<string>('');
  const lastCueUpdateRef = useRef<number>(0);

  // Control states using refs to avoid re-renders
  const controlsVisibleRef = useRef(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const toggleCaptionsRef = useRef(true);
  const [toggleCaptions, setToggleCaptions] = useState(true);

  // Show play button - derived state
  const showPlayButton = videoLoaded && !hasPlayedOnce && !hasError;

  // Refs for cleanup and retry management
  const retryCount = useRef(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(Date.now());
  const isMountedRef = useRef(true);
  const captionTrackRef = useRef<TextTrack | null>(null);

  // Thumbnail optimization
  const lastThumbnailTime = useRef<number>(0);
  const thumbnailCache = useRef<Map<number, string>>(new Map());

  const maxRetries = 3;



  // Cleanup function to clear all timeouts
  const clearAllTimeouts = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  // Safe state setter that checks if component is mounted
  const safeSetState = useCallback((setter: () => void) => {
    if (isMountedRef.current) {
      setter();
    }
  }, []);

  // Throttled controls visibility update
  const updateControlsVisibility = useCallback((visible: boolean) => {
    if (controlsVisibleRef.current !== visible) {
      controlsVisibleRef.current = visible;
      setControlsVisible(visible);
    }
  }, []);

  // Throttled caption toggle update
  const updateToggleCaptions = useCallback((toggle: boolean) => {
    if (toggleCaptionsRef.current !== toggle) {
      toggleCaptionsRef.current = toggle;
      setToggleCaptions(toggle);
    }
  }, []);

  // Mobile detection with debouncing
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const checkMobile = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        const newIsMobile = window.innerWidth < 640;
        if (newIsMobile !== isMobile) {
          safeSetState(() => setIsMobile(newIsMobile));
        }
      }, 100);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('resize', checkMobile);
    };
  }, [isMobile, safeSetState]);

  // URL resolution
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

      safeSetState(() => {
        if (isCorsIncompatible) {
          console.log('CapVideoPlayer: Detected CORS-incompatible URL, disabling crossOrigin:', finalUrl);
          setUseCrossOrigin(false);
        } else {
          setUseCrossOrigin(enableCrossOrigin);
        }
        setResolvedVideoSrc(finalUrl);
        setUrlResolved(true);
      });

      return finalUrl;
    } catch (error) {
      console.error("CapVideoPlayer: Error fetching new video URL:", error);
      const timestamp = new Date().getTime();
      const fallbackUrl = videoSrc.includes("?")
        ? `${videoSrc}&_t=${timestamp}`
        : `${videoSrc}?_t=${timestamp}`;

      safeSetState(() => {
        setResolvedVideoSrc(fallbackUrl);
        setUrlResolved(true);
      });

      return fallbackUrl;
    }
  }, [videoSrc, enableCrossOrigin, safeSetState]);

  // Video reload function
  const reloadVideo = useCallback(async () => {
    const video = videoRef.current;
    if (!video || retryCount.current >= maxRetries || !isMountedRef.current) return;

    console.log(`Reloading video (attempt ${retryCount.current + 1}/${maxRetries})`);

    const currentPosition = video.currentTime;
    const wasPlaying = !video.paused;

    video.load();

    if (currentPosition > 0) {
      const restorePosition = () => {
        if (!isMountedRef.current) return;

        video.currentTime = currentPosition;
        if (wasPlaying) {
          video.play().catch((err) => console.error("Error resuming playback:", err));
        }
        video.removeEventListener("canplay", restorePosition);
      };
      video.addEventListener("canplay", restorePosition);
    }

    retryCount.current += 1;
  }, [videoRef, maxRetries]);

  // Retry setup with exponential backoff
  const setupRetry = useCallback(() => {
    clearAllTimeouts();

    if (retryCount.current >= maxRetries) {
      console.error(`Video failed to load after ${maxRetries} attempts`);
      safeSetState(() => {
        setHasError(true);
        setIsRetrying(false);
      });
      return;
    }

    const elapsedMs = Date.now() - startTimeRef.current;
    if (elapsedMs > 60000) {
      console.error("Video failed to load after 1 minute");
      safeSetState(() => {
        setHasError(true);
        setIsRetrying(false);
      });
      return;
    }

    const retryInterval = RETRY_INTERVALS[retryCount.current] || 10000;

    console.log(`Retrying video load in ${retryInterval}ms (attempt ${retryCount.current + 1}/${maxRetries})`);

    retryTimeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        reloadVideo();
      }
    }, retryInterval);
  }, [clearAllTimeouts, maxRetries, safeSetState, reloadVideo]);

  // Reset state when video source changes
  useEffect(() => {
    safeSetState(() => {
      setResolvedVideoSrc(videoSrc);
      setVideoLoaded(false);
      setHasError(false);
      setIsRetrying(false);
      setUrlResolved(false);
      setUseCrossOrigin(enableCrossOrigin);
      setHasPlayedOnce(false);
    });

    // Reset refs
    currentCueRef.current = '';
    setCurrentCue('');
    retryCount.current = 0;
    startTimeRef.current = Date.now();
    clearAllTimeouts();

    // Clear thumbnail cache
    thumbnailCache.current.clear();
  }, [videoSrc, enableCrossOrigin, safeSetState, clearAllTimeouts]);

  // Resolve video URL on mount and when videoSrc changes
  useEffect(() => {
    fetchNewUrl();
  }, [fetchNewUrl]);

  // Optimized cue change handler with throttling
  const handleCueChange = useCallback((): void => {
    const track = captionTrackRef.current;
    if (!track || !track.activeCues || track.activeCues.length === 0) {
      if (currentCueRef.current !== '') {
        currentCueRef.current = '';
        safeSetState(() => setCurrentCue(''));
      }
      return;
    }

    const cue = track.activeCues[0] as VTTCue;
    const plainText = cue.text.replace(/<[^>]*>/g, '');

    // Only update if text actually changed
    if (currentCueRef.current !== plainText) {
      currentCueRef.current = plainText;

      // Throttle updates to prevent excessive re-renders
      const now = Date.now();
      if (now - lastCueUpdateRef.current > 100) { // 100ms throttle
        lastCueUpdateRef.current = now;
        safeSetState(() => setCurrentCue(plainText));
      }
    }
  }, [safeSetState]);

  // Caption track management
  const setupTracks = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    // Clean up previous track listener
    if (captionTrackRef.current) {
      captionTrackRef.current.removeEventListener('cuechange', handleCueChange);
      captionTrackRef.current = null;
    }

    // Try to find caption tracks, with a small delay to ensure they're loaded
    const findTracks = () => {
      const tracks = Array.from(video.textTracks);
      for (const track of tracks) {
        if (track.kind === 'captions' || track.kind === 'subtitles') {
          captionTrackRef.current = track;
          track.mode = 'hidden';
          track.addEventListener('cuechange', handleCueChange);
          return true;
        }
      }
      return false;
    };

    // Try immediately, then retry after a delay if not found
    if (!findTracks()) {
      setTimeout(findTracks, 100);
    }
  }, [videoRef, handleCueChange]);

  // Optimized thumbnail generation with caching and throttling
  const generateVideoFrameThumbnail = useCallback((time: number): string => {
    const video = videoRef.current;
    const roundedTime = Math.floor(time);

    if (!video || !useCrossOrigin) {
      return `https://placeholder.pics/svg/224x128/1f2937/ffffff/Loading ${roundedTime}s`;
    }

    // Check cache first
    if (thumbnailCache.current.has(roundedTime)) {
      return thumbnailCache.current.get(roundedTime)!;
    }

    // Throttle generation to prevent performance issues
    const now = Date.now();
    if (now - lastThumbnailTime.current < 100) { // 100ms throttle
      return `https://placeholder.pics/svg/224x128/1f2937/ffffff/Loading ${roundedTime}s`;
    }
    lastThumbnailTime.current = now;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = 224;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');

      if (ctx && video.videoWidth > 0 && video.videoHeight > 0) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);

        // Cache the result (limit cache size)
        if (thumbnailCache.current.size > 50) {
          const firstKey = thumbnailCache.current.keys().next().value;
          if (firstKey !== undefined) {
            thumbnailCache.current.delete(firstKey);
          }
        }
        thumbnailCache.current.set(roundedTime, dataUrl);

        return dataUrl;
      }
    } catch (error) {
      console.warn('CapVideoPlayer: Could not generate thumbnail due to CORS:', error);
    }

    return `https://placeholder.pics/svg/224x128/dc2626/ffffff/Error`;
  }, [videoRef, useCrossOrigin]);

  // Batched state updates for video events
  const handleVideoLoaded = useCallback(() => {
    safeSetState(() => {
      setVideoLoaded(true);
      setHasError(false);
      setIsRetrying(false);
    });
    clearAllTimeouts();
  }, [safeSetState, clearAllTimeouts]);

  const handleVideoPlay = useCallback(() => {
    safeSetState(() => {
      setHasPlayedOnce(true);
    });
  }, [safeSetState]);

  // Main video event handlers
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !urlResolved) return;

    const handleLoadedData = () => {
      handleVideoLoaded();
    };

    const handleCanPlay = () => {
      handleVideoLoaded();
    };

    const handleLoadedMetadata = () => {
      handleVideoLoaded();
      setupTracks();
    };

    const handlePlay = () => {
      handleVideoPlay();
    };

    const handleError = (e: Event) => {
      const error = (e.target as HTMLVideoElement).error;
      console.error('CapVideoPlayer: Video error detected:', error);

      if (!videoLoaded && !hasError && !isRetrying) {
        safeSetState(() => {
          setIsRetrying(true);
          setHasError(false);
        });
        setupRetry();
      }
    };

    // Add event listeners
    video.addEventListener('loadeddata', handleLoadedData);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('play', handlePlay);
    video.addEventListener('error', handleError as EventListener);

    // Check if video is already ready
    if (video.readyState >= 2) {
      handleLoadedData();
    }

    // Initial timeout for slow loading videos
    let initialTimeoutId: NodeJS.Timeout | null = null;
    if (!videoLoaded && !hasError && retryCount.current === 0) {
      initialTimeoutId = setTimeout(() => {
        if (!videoLoaded && !hasError && isMountedRef.current) {
          console.log("Video taking longer than expected to load, attempting reload");
          safeSetState(() => setIsRetrying(true));
          setupRetry();
        }
      }, 10000);
    }

    // Cleanup function
    return () => {
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('error', handleError as EventListener);

      if (initialTimeoutId) {
        clearTimeout(initialTimeoutId);
      }
    };
  }, [videoRef, urlResolved, videoLoaded, hasError, isRetrying, handleVideoLoaded, handleVideoPlay, safeSetState, setupRetry, setupTracks]);

  // Component unmount cleanup
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      clearAllTimeouts();

      // Clean up caption track listener
      if (captionTrackRef.current) {
        captionTrackRef.current.removeEventListener('cuechange', handleCueChange);
        captionTrackRef.current = null;
      }

      // Clear thumbnail cache
      thumbnailCache.current.clear();
    };
  }, [clearAllTimeouts, handleCueChange]);

  return (
    <MediaPlayer
      onMouseEnter={() => updateControlsVisibility(true)}
      onMouseLeave={() => updateControlsVisibility(false)}
      onTouchStart={() => updateControlsVisibility(true)}
      onTouchEnd={() => updateControlsVisibility(false)}
      className={clsx(mediaPlayerClassName, "[&::-webkit-media-text-track-display]:!hidden")}
      autoHide
    >
      {/* Error fallback UI */}
      {hasError && (
        <div className="flex absolute inset-0 z-20 justify-center items-center bg-black">
          <div className="flex flex-col gap-4 items-center p-6 text-center">
            <div className="text-4xl text-red-500">⚠️</div>
            <div className="text-white">
              <h3 className="mb-2 text-lg font-semibold">Video unavailable</h3>
              <p className="mb-4 text-sm opacity-75">
                We're having trouble loading this video. Please try refreshing the page.
              </p>
              <button
                onClick={() => {
                  safeSetState(() => {
                    setHasError(false);
                    setVideoLoaded(false);
                    setIsRetrying(false);
                  });
                  retryCount.current = 0;
                  startTimeRef.current = Date.now();
                  clearAllTimeouts();
                  fetchNewUrl();
                }}
                className="px-4 py-2 text-white bg-blue-500 rounded transition-colors hover:bg-blue-600"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Loading spinner */}
      {!hasError && (
        <div
          className={clsx(
            "flex absolute inset-0 z-10 justify-center items-center bg-black transition-opacity duration-300",
            videoLoaded ? "opacity-0 pointer-events-none" : "opacity-100"
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
      )}

      {/* Video element */}
      {urlResolved && (
        <MediaPlayerVideo
          src={resolvedVideoSrc}
          ref={videoRef}
          onLoadedData={handleVideoLoaded}
          onPlay={handleVideoPlay}
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

      {/* Play button overlay */}
      <AnimatePresence>
        {showPlayButton && (
          <motion.div
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.2 }}
            onClick={() => videoRef.current?.play()}
            className="flex absolute inset-0 z-10 justify-center items-center m-auto bg-blue-500 rounded-full transition-colors transform cursor-pointer hover:bg-blue-600 size-12 xs:size-20 md:size-32"
            role="button"
            aria-label="Play video"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                videoRef.current?.play();
              }
            }}
          >
            <FontAwesomeIcon icon={faPlay} className="text-white size-4 xs:size-8 md:size-12" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Custom captions */}
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

      {/* Media player components */}
      <MediaPlayerLoading />
      {!isRetrying && <MediaPlayerError />}
      <MediaPlayerVolumeIndicator />

      <MediaPlayerControls className="flex-col items-start gap-2.5">
        <MediaPlayerControlsOverlay />
        <MediaPlayerSeek
          tooltipThumbnailSrc={isMobile || !useCrossOrigin ? undefined : generateVideoFrameThumbnail}
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
            <MediaPlayerCaptions setToggleCaptions={updateToggleCaptions} toggleCaptions={toggleCaptions} />
            <MediaPlayerSettings />
            <MediaPlayerPiP />
            <MediaPlayerFullscreen />
          </div>
        </div>
      </MediaPlayerControls>
    </MediaPlayer>
  );
}

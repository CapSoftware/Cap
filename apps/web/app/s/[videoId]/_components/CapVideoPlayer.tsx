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
import { useEffect, useCallback, useState } from "react";
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

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 640);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Fetch new URL with redirect resolution and pre-emptive CORS detection
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
      // On fetch error, disable CORS to be safe
      setUseCrossOrigin(false);
      const timestamp = new Date().getTime();
      const fallbackUrl = videoSrc.includes("?")
        ? `${videoSrc}&_t=${timestamp}`
        : `${videoSrc}?_t=${timestamp}`;
      setResolvedVideoSrc(fallbackUrl);
      setUrlResolved(true);
      return fallbackUrl;
    }
  }, [videoSrc, enableCrossOrigin]);

  // Resolve video URL on mount and when videoSrc changes
  useEffect(() => {
    fetchNewUrl();
  }, [fetchNewUrl]);

  // Reset URL resolution state when video source changes
  useEffect(() => {
    setUrlResolved(false);
    setUseCrossOrigin(enableCrossOrigin);
  }, [videoSrc, enableCrossOrigin]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !urlResolved) return;

    const handleLoadedData = () => {
      setVideoLoaded(true);
      if (!hasPlayedOnce) {
        setShowPlayButton(true);
      }
    };

    const handleCanPlay = () => {
      setVideoLoaded(true);
      if (!hasPlayedOnce) {
        setShowPlayButton(true);
      }
    };

    const handleLoadedMetadata = () => {
      setVideoLoaded(true);
      if (!hasPlayedOnce) {
        setShowPlayButton(true);
      }
    };

    const handleLoad = () => {
      setVideoLoaded(true);
      if (!hasPlayedOnce) {
        setShowPlayButton(true);
      }
    };

    const handlePlay = () => {
      setShowPlayButton(false);
      setHasPlayedOnce(true);
    };

    const handleError = (e: Event) => {
      const error = (e.target as HTMLVideoElement).error;
      console.error('CapVideoPlayer: Video error detected:', {
        error,
        code: error?.code,
        message: error?.message,
        videoSrc
      });

      // CORS errors are now handled at the ShareVideo level via enableCrossOrigin prop
      if (error && (error.code === 4 || error.message?.includes('CORS'))) {
        console.log('CapVideoPlayer: CORS error detected - this should be prevented by ShareVideo logic');
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
    video.addEventListener('error', handleError);

    if (video.readyState >= 2) {
      setVideoLoaded(true);
      if (!hasPlayedOnce) {
        setShowPlayButton(true);
      }
    }

    // Setup tracks immediately if video is already loaded
    if (video.readyState >= 1) {
      setupTracks();
    }

    return () => {
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('loadedmetadata', handleLoadedMetadataWithTracks);
      video.removeEventListener('load', handleLoad);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('error', handleError);
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
          <LogoSpinner className="w-8 h-auto animate-spin sm:w-10" />
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
        <MediaPlayerError />
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

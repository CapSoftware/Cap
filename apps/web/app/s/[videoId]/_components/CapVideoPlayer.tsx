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
import { useRef, useEffect, useCallback, useState } from "react";
import Hls from "hls.js";
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
  hlsVideo?: boolean;
}

export function CapVideoPlayer({
  videoSrc,
  chaptersSrc,
  captionsSrc,
  videoRef,
  mediaPlayerClassName,
  autoplay = false,
  hlsVideo = false
}: Props) {
  const hlsInstance = useRef<Hls | null>(null);
  const [currentCue, setCurrentCue] = useState<string>('');
  const [controlsVisible, setControlsVisible] = useState(false);
  const [toggleCaptions, setToggleCaptions] = useState(true);
  const [showPlayButton, setShowPlayButton] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [hasPlayedOnce, setHasPlayedOnce] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [resolvedVideoSrc, setResolvedVideoSrc] = useState<string>(videoSrc);

  // Resolve redirect URLs to prevent CORS issues
  useEffect(() => {
    const resolveVideoUrl = async () => {
      try {
        // If it's not an API URL, use it directly
        if (!videoSrc.startsWith('/api/')) {
          console.log('CapVideoPlayer: Using direct URL:', videoSrc);
          setResolvedVideoSrc(videoSrc);
          return;
        }

        console.log('CapVideoPlayer: Resolving redirect for:', videoSrc);

        // Add timestamp to prevent caching issues
        const timestamp = new Date().getTime();
        const urlWithTimestamp = videoSrc.includes('?') 
          ? `${videoSrc}&_t=${timestamp}` 
          : `${videoSrc}?_t=${timestamp}`;

        const response = await fetch(urlWithTimestamp, { method: 'HEAD' });
        
        console.log('CapVideoPlayer: HEAD response status:', response.status);
        console.log('CapVideoPlayer: HEAD response redirected:', response.redirected);
        console.log('CapVideoPlayer: HEAD response URL:', response.url);
        
        if (response.redirected) {
          // Use the final redirected URL
          console.log('CapVideoPlayer: Using redirected URL:', response.url);
          setResolvedVideoSrc(response.url);
        } else {
          // Use the original URL with timestamp
          console.log('CapVideoPlayer: Using original URL with timestamp:', urlWithTimestamp);
          setResolvedVideoSrc(urlWithTimestamp);
        }
      } catch (error) {
        console.error('CapVideoPlayer: Error resolving video URL:', error);
        // Fallback to original URL
        console.log('CapVideoPlayer: Falling back to original URL:', videoSrc);
        setResolvedVideoSrc(videoSrc);
      }
    };

    resolveVideoUrl();
  }, [videoSrc]);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 640);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

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
      if (!hlsVideo) {
        setVideoLoaded(true);
        if (!hasPlayedOnce) {
          setShowPlayButton(true);
        }
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

    video.addEventListener('loadeddata', handleLoadedData);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('load', handleLoad);
    video.addEventListener('play', handlePlay);

    if (video.readyState >= 2) {
      setVideoLoaded(true);
      if (!hasPlayedOnce) {
        setShowPlayButton(true);
      }
    }

    return () => {
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('load', handleLoad);
      video.removeEventListener('play', handlePlay);
    };
  }, [hlsVideo, hasPlayedOnce]);

  useEffect(() => {
    if (!videoRef.current || !hlsVideo || !resolvedVideoSrc) return;

    const videoElement = videoRef.current;

    if (!Hls.isSupported()) {
      return;
    }
    const isHlsStream = resolvedVideoSrc.includes('.m3u8');

    if (!isHlsStream) {
      return;
    }

    if (hlsInstance.current) {
      hlsInstance.current.destroy();
      hlsInstance.current = null;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
    });
    const currentTime = videoElement.currentTime;
    const wasPaused = videoElement.paused;

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            hls.destroy();
            break;
        }
      }
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (currentTime > 0) {
        videoElement.currentTime = currentTime;
      }

      if (!wasPaused && autoplay) {
        videoElement.play().catch(err =>
          console.error("Error resuming playback:", err)
        );
      }
    });

    hls.on(Hls.Events.FRAG_LOADED, () => {
      if (!videoLoaded) {
        setVideoLoaded(true);
        if (!hasPlayedOnce) {
          setShowPlayButton(true);
        }
      }
    });

    hls.loadSource(resolvedVideoSrc);
    hls.attachMedia(videoElement);

    hlsInstance.current = hls;
    return () => {
      if (hlsInstance.current) {
        hlsInstance.current.destroy();
        hlsInstance.current = null;
      }
    };
  }, [resolvedVideoSrc, hlsVideo, autoplay, videoLoaded, hasPlayedOnce]);

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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

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

    const handleLoadedMetadata = (): void => {
      setupTracks();
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);

    if (video.readyState >= 1) {
      setupTracks();
    }

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      if (captionTrack) {
        captionTrack.removeEventListener('cuechange', handleCueChange);
      }
    };
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
        <MediaPlayerVideo
          src={hlsVideo ? undefined : resolvedVideoSrc}
          ref={videoRef}
          onPlay={() => {
            setShowPlayButton(false);
            setHasPlayedOnce(true);
          }}
          crossOrigin="anonymous"
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
          <MediaPlayerSeek tooltipThumbnailSrc={isMobile ? undefined : generateVideoFrameThumbnail} />
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

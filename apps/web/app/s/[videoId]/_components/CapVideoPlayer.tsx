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

  // Set up video event listeners for better loading detection
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleLoadedData = () => {
      console.log('Video loadeddata event fired');
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
      console.log('Video already loaded, readyState:', video.readyState);
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
    if (!videoRef.current || !hlsVideo) return;

    const videoElement = videoRef.current;

    if (!Hls.isSupported()) {
      console.warn("HLS is not supported in this browser");
      return;
    }
    const isHlsStream = videoSrc.includes('.m3u8');

    if (!isHlsStream) {
      console.warn("Video source doesn't appear to be an HLS stream");
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
      console.error("HLS error:", data);

      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.log("Network error, trying to recover...");
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.log("Media error, trying to recover...");
            hls.recoverMediaError();
            break;
          default:
            console.error("Fatal error, destroying HLS instance");
            hls.destroy();
            break;
        }
      }
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      console.log("HLS manifest parsed successfully");

      if (currentTime > 0) {
        videoElement.currentTime = currentTime;
      }

      if (!wasPaused && autoplay) {
        videoElement.play().catch(err =>
          console.error("Error resuming playback:", err)
        );
      }
    });

    // HLS specific events for better loading detection
    hls.on(Hls.Events.FRAG_LOADED, () => {
      console.log("HLS fragment loaded");
      // Set video as loaded when first fragment is loaded
      if (!videoLoaded) {
        setVideoLoaded(true);
        if (!hasPlayedOnce) {
          setShowPlayButton(true);
        }
      }
    });

    hls.loadSource(videoSrc);
    hls.attachMedia(videoElement);

    hlsInstance.current = hls;
    return () => {
      if (hlsInstance.current) {
        hlsInstance.current.destroy();
        hlsInstance.current = null;
      }
    };
  }, [videoSrc, hlsVideo, autoplay, videoLoaded, hasPlayedOnce]);

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
        console.error('Error capturing video frame:', error);
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
          src={hlsVideo ? undefined : videoSrc}
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
              "absolute left-1/2 transform -translate-x-1/2 text-xl z-40 pointer-events-none bg-black/80 text-white px-4 py-2 rounded-md text-center max-w-[80%] transition-all duration-300 ease-in-out",
              controlsVisible || videoRef.current?.paused ? 'bottom-20' : 'bottom-12'
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
          <MediaPlayerSeek tooltipThumbnailSrc={generateVideoFrameThumbnail} />
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

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
}

export function HLSVideoPlayer({
  videoSrc,
  chaptersSrc,
  captionsSrc,
  videoRef,
  mediaPlayerClassName,
  autoplay = false
}: Props) {
  const hlsInstance = useRef<Hls | null>(null);
  const [currentCue, setCurrentCue] = useState<string>('');
  const [controlsVisible, setControlsVisible] = useState(false);
  const [toggleCaptions, setToggleCaptions] = useState(true);
  const [showPlayButton, setShowPlayButton] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [hasPlayedOnce, setHasPlayedOnce] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

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
      console.error('HLSVideoPlayer: Video error detected:', {
        error,
        code: error?.code,
        message: error?.message,
        videoSrc
      });
    };

    video.addEventListener('loadeddata', handleLoadedData);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('load', handleLoad);
    video.addEventListener('play', handlePlay);
    video.addEventListener('error', handleError);

    if (video.readyState >= 2) {
      setVideoLoaded(true);
      if (!hasPlayedOnce) {
        setShowPlayButton(true);
      }
    }

    return () => {
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('load', handleLoad);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('error', handleError);
    };
  }, [hasPlayedOnce, videoSrc]);

  // HLS setup
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSrc) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
      });

      hlsInstance.current = hls;

      hls.loadSource(videoSrc);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('HLSVideoPlayer: HLS manifest parsed successfully');
        setVideoLoaded(true);
        if (!hasPlayedOnce) {
          setShowPlayButton(true);
        }
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLSVideoPlayer: HLS error:', event, data);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('HLSVideoPlayer: Fatal network error encountered, trying to recover');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('HLSVideoPlayer: Fatal media error encountered, trying to recover');
              hls.recoverMediaError();
              break;
            default:
              console.log('HLSVideoPlayer: Fatal error, cannot recover');
              hls.destroy();
              break;
          }
        }
      });

      return () => {
        if (hlsInstance.current) {
          hlsInstance.current.destroy();
          hlsInstance.current = null;
        }
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = videoSrc;
      console.log('HLSVideoPlayer: Using native HLS support');
    } else {
      console.error('HLSVideoPlayer: HLS is not supported in this browser');
    }
  }, [videoSrc, hasPlayedOnce]);

  // Caption handling
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !captionsSrc) return;

    let captionTrack: TextTrack | null = null;

    const handleCueChange = (): void => {
      if (captionTrack && captionTrack.activeCues && captionTrack.activeCues.length > 0) {
        const activeCue = captionTrack.activeCues[0] as VTTCue;
        setCurrentCue(activeCue.text);
      } else {
        setCurrentCue('');
      }
    };

    const setupTracks = (): void => {
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (track && (track.kind === 'captions' || track.kind === 'subtitles')) {
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
  }, [captionsSrc]);

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
          src={undefined} // HLS source is handled by HLS.js
          ref={videoRef}
          onPlay={() => {
            setShowPlayButton(false);
            setHasPlayedOnce(true);
          }}
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
          <MediaPlayerSeek />
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

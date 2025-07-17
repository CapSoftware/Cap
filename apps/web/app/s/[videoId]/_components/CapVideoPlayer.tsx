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
import { useRef, useEffect, useCallback } from "react";
import Hls from "hls.js";
import clsx from "clsx";

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

    hls.loadSource(videoSrc);
    hls.attachMedia(videoElement);

    hlsInstance.current = hls;
    return () => {
      if (hlsInstance.current) {
        hlsInstance.current.destroy();
        hlsInstance.current = null;
      }
    };
  }, [videoSrc, hlsVideo, autoplay]);

  const generateVideoFrameThumbnail = useCallback((time: number): string => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      // Fallback while video is loading
      return `https://via.placeholder.com/224x128/1f2937/ffffff?text=${Math.floor(time)}s`;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 224;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return `https://via.placeholder.com/224x128/dc2626/ffffff?text=Error`;
    }

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.8);
    } catch (error) {
      console.error('Error capturing video frame:', error);
      return `https://via.placeholder.com/224x128/dc2626/ffffff?text=Error`;
    }
  }, []);

  return (
    <>
      <MediaPlayer className={clsx(mediaPlayerClassName, "media-player")} autoHide>
        <MediaPlayerVideo
          src={hlsVideo ? undefined : videoSrc}
          ref={videoRef}
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
              <MediaPlayerCaptions />
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

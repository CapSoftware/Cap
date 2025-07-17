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
import { useRef, useEffect } from "react";
import Hls from "hls.js";

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

  return (
    <MediaPlayer className={mediaPlayerClassName} autoHide>
      <MediaPlayerVideo
        src={hlsVideo ? undefined : videoSrc}
        ref={videoRef}
        muted
        playsInline
        autoPlay={autoplay}
      >
        <track
          default
          kind="chapters"
          src={chaptersSrc}
        />
        <track
          default
          kind="metadata"
          label="thumbnails"
          src="https://image.mux.com/Sc89iWAyNkhJ3P1rQ02nrEdCFTnfT01CZ2KmaEcxXfB008/storyboard.vtt"
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
            <MediaPlayerCaptions />
            <MediaPlayerSettings />
            <MediaPlayerPiP />
            <MediaPlayerFullscreen />
          </div>
        </div>
      </MediaPlayerControls>
    </MediaPlayer>
  );
}

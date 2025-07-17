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

interface Props {
  videoSrc: string;
  chaptersSrc: string;
  captionsSrc: string;
  videoRef?: React.Ref<HTMLVideoElement>;
  mediaPlayerClassName?: string;
}

export function CapVideoPlayer({ videoSrc, chaptersSrc, captionsSrc, videoRef, mediaPlayerClassName }: Props) {
  return (
    <MediaPlayer className={mediaPlayerClassName} autoHide>
      <MediaPlayerVideo
        src={videoSrc}
        ref={videoRef}
        crossOrigin=""
        muted
        playsInline
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

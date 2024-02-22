import {
  memo,
  forwardRef,
  useEffect,
  useRef,
  useImperativeHandle,
} from "react";
import Hls from "hls.js";

interface VideoPlayerProps {
  videoSrc: string;
  audioSrc?: string;
  videoStartTime: number | null;
  audioStartTime: number | null;
}

export const VideoPlayer = memo(
  forwardRef<HTMLVideoElement, VideoPlayerProps>(
    ({ videoSrc, audioSrc, videoStartTime, audioStartTime }, ref) => {
      const videoRef = useRef<HTMLVideoElement>(null);
      const audioRef = useRef<HTMLAudioElement>(null);
      const videoHlsInstance = useRef<Hls | null>(null);
      const audioHlsInstance = useRef<Hls | null>(null);

      useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

      const initializeHls = (
        src: string,
        media: HTMLMediaElement,
        hlsInstance: React.MutableRefObject<Hls | null>
      ) => {
        if (Hls.isSupported()) {
          const hls = new Hls();
          hlsInstance.current = hls;
          hls.loadSource(src);
          hls.attachMedia(media);
        } else if (media.canPlayType("application/vnd.apple.mpegurl")) {
          media.src = src;
        }
      };

      useEffect(() => {
        if (!videoRef.current) return;
        initializeHls(videoSrc, videoRef.current, videoHlsInstance);

        return () => {
          videoHlsInstance.current?.destroy();
        };
      }, [videoSrc]);

      useEffect(() => {
        if (!audioSrc || !audioRef.current) return;
        initializeHls(audioSrc, audioRef.current, audioHlsInstance);

        return () => {
          audioHlsInstance.current?.destroy();
        };
      }, [audioSrc]);

      useEffect(() => {
        if (
          !videoRef.current ||
          !audioSrc ||
          !audioRef.current ||
          videoStartTime === null ||
          audioStartTime === null
        )
          return;

        const timeDifferenceInSeconds =
          (audioStartTime - videoStartTime) / 1000;

        console.log("timeDifferenceInSeconds", timeDifferenceInSeconds);

        if (timeDifferenceInSeconds > 0) {
          videoRef.current.currentTime = timeDifferenceInSeconds;
          audioRef.current.currentTime = 0;
        } else {
          audioRef.current.currentTime = -timeDifferenceInSeconds;
          videoRef.current.currentTime = 0;
        }
      }, [videoStartTime, audioStartTime, audioSrc]);

      useEffect(() => {
        if (!audioSrc || !videoRef.current || !audioRef.current) return;
        const video = videoRef.current;
        const audio = audioRef.current;

        const playListener = async () => {
          if (audio.paused) {
            await audio.play();
          }
        };

        const pauseListener = () => {
          if (!audio.paused) {
            audio.pause();
          }
        };

        const seekListener = () => {
          if (audioStartTime !== null && videoStartTime !== null) {
            const startOffsetSeconds = (audioStartTime - videoStartTime) / 1000;
            console.log("startOffsetSeconds", startOffsetSeconds);
            audio.currentTime = video.currentTime + startOffsetSeconds;
          }
        };

        video.addEventListener("play", playListener);
        video.addEventListener("pause", pauseListener);
        video.addEventListener("seeked", seekListener);

        return () => {
          video.removeEventListener("play", playListener);
          video.removeEventListener("pause", pauseListener);
          video.removeEventListener("seeked", seekListener);
        };
      }, [audioSrc, videoStartTime, audioStartTime]);

      return (
        <>
          <video
            ref={videoRef}
            className="absolute top-0 left-0 rounded-lg w-full h-full object-contain"
            preload="metadata"
            playsInline
            controls={false}
          />
          {audioSrc && (
            <audio
              muted={false}
              ref={audioRef}
              style={{ display: "none" }}
              preload="metadata"
            />
          )}
        </>
      );
    }
  )
);

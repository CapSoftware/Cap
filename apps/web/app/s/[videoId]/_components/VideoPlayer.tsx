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
}

export const VideoPlayer = memo(
  forwardRef<HTMLVideoElement, VideoPlayerProps>(
    ({ videoSrc, audioSrc }, ref) => {
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
        const hls = new Hls();
        hlsInstance.current = hls;
        hls.loadSource(src);
        hls.attachMedia(media);
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
          audio.currentTime = video.currentTime;
        };

        const volumeChangeListener = () => {
          audio.muted = video.muted;
        };

        const endedListener = () => {
          audio.pause();
          audio.currentTime = 0;
        };

        video.addEventListener("play", playListener);
        video.addEventListener("pause", pauseListener);
        video.addEventListener("seeked", seekListener);
        video.addEventListener("volumechange", volumeChangeListener);
        video.addEventListener("ended", endedListener);

        return () => {
          video.removeEventListener("play", playListener);
          video.removeEventListener("pause", pauseListener);
          video.removeEventListener("seeked", seekListener);
          video.removeEventListener("volumechange", volumeChangeListener);
          video.removeEventListener("ended", endedListener);
        };
      }, [audioSrc]);

      return (
        <>
          <video
            id="video-player"
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
              controls={false}
              playsInline
            />
          )}
        </>
      );
    }
  )
);

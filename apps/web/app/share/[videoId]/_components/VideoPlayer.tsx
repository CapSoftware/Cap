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
  videoStartTime: number | null; // These are Unix timestamps
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
          media.onloadedmetadata = () => {
            if (media === videoRef.current && videoStartTime) {
              const videoCurrentTime = Date.now() / 1000 - videoStartTime;
              videoRef.current.currentTime = Math.max(0, videoCurrentTime);
            } else if (media === audioRef.current && audioStartTime) {
              const audioCurrentTime = Date.now() / 1000 - audioStartTime;
              audioRef.current.currentTime = Math.max(0, audioCurrentTime);
            }
          };
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

      // No need for a separate useEffect for synchronization since it's handled within initializeHls

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

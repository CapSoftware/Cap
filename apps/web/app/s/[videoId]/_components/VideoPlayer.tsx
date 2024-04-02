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
}

export const VideoPlayer = memo(
  forwardRef<HTMLVideoElement, VideoPlayerProps>(({ videoSrc }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const videoHlsInstance = useRef<Hls | null>(null);

    useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

    const initializeHls = (
      src: string,
      media: HTMLMediaElement,
      hlsInstance: React.MutableRefObject<Hls | null>
    ) => {
      const hls = new Hls({ progressive: true });
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error("HLS error:", data);
      });

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

    return (
      <video
        id="video-player"
        ref={videoRef}
        className="absolute top-0 left-0 rounded-lg w-full h-full object-contain"
        preload="metadata"
        playsInline
        controls={false}
      />
    );
  })
);

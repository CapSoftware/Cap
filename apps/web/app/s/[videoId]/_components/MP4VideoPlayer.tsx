import {
  memo,
  forwardRef,
  useRef,
  useImperativeHandle,
  useEffect,
} from "react";

interface MP4VideoPlayerProps {
  videoSrc: string;
}

// million-ignore
export const MP4VideoPlayer = memo(
  forwardRef<HTMLVideoElement, MP4VideoPlayerProps>(({ videoSrc }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;

      const handleLoadedMetadata = () => {
        // Trigger a canplay event after metadata is loaded
        video.dispatchEvent(new Event("canplay"));
      };

      const handleError = (e: ErrorEvent) => {
        console.error("Video loading error:", e);
        // Attempt to reload on error
        video.load();
      };

      video.addEventListener("loadedmetadata", handleLoadedMetadata);
      video.addEventListener("error", handleError as EventListener);

      // Initial load
      video.load();

      return () => {
        video.removeEventListener("loadedmetadata", handleLoadedMetadata);
        video.removeEventListener("error", handleError as EventListener);
      };
    }, [videoSrc]);

    return (
      <video
        id="video-player"
        ref={videoRef}
        className="w-full h-full object-contain"
        preload="auto"
        playsInline
        controls={false}
        muted
      >
        <source src={videoSrc} type="video/mp4" />
      </video>
    );
  })
);

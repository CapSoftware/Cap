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

      const startTime = Date.now();
      const maxDuration = 2 * 60 * 1000;

      const checkAndReload = () => {
        if (video.readyState === 0) {
          // HAVE_NOTHING
          video.load();
        }

        if (Date.now() - startTime < maxDuration) {
          setTimeout(checkAndReload, 3000);
        }
      };

      checkAndReload();

      return () => {
        clearTimeout(checkAndReload as unknown as number);
      };
    }, [videoSrc]);

    return (
      <video
        id="video-player"
        ref={videoRef}
        className="w-full h-full object-contain"
        preload="metadata"
        playsInline
        controls={false}
        muted
      >
        <source src={videoSrc} type="video/mp4" />
      </video>
    );
  })
);

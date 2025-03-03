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
      const hls = new Hls();
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error("HLS error:", data);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
                setTimeout(() => {
                  console.log("Retrying...");
                  hls.loadSource(src);
                }, 500);
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              break;
          }
        }
      });
      hlsInstance.current = hls;
      hls.loadSource(src);
      hls.attachMedia(media);
    };

    useEffect(() => {
      if (!videoRef.current) return;

      const videoElement = videoRef.current;

      // Store current position and play state before reinitializing
      const currentPosition = videoElement.currentTime;
      const wasPlaying = !videoElement.paused;

      // Add event listener for when HLS is ready to play
      const handleHlsManifestParsed = () => {
        if (videoElement) {
          // Restore position after HLS is ready
          if (currentPosition > 0) {
            videoElement.currentTime = currentPosition;
            if (wasPlaying) {
              videoElement
                .play()
                .catch((err) => console.error("Error resuming playback:", err));
            }
          }
          videoElement.dispatchEvent(new Event("canplay"));
        }
      };

      initializeHls(videoSrc, videoRef.current, videoHlsInstance);

      // Add event listener for HLS manifest parsed
      if (videoHlsInstance.current) {
        videoHlsInstance.current.on(
          Hls.Events.MANIFEST_PARSED,
          handleHlsManifestParsed
        );
      }

      return () => {
        if (videoHlsInstance.current) {
          videoHlsInstance.current.off(
            Hls.Events.MANIFEST_PARSED,
            handleHlsManifestParsed
          );
          videoHlsInstance.current.destroy();
        }
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
        muted
      >
        <source src={videoSrc} type="video/mp4" />
      </video>
    );
  })
);

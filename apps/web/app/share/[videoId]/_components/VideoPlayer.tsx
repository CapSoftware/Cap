import React, { forwardRef, useEffect } from "react";
import Hls from "hls.js";

interface VideoPlayerProps {
  src: string;
}

export const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(
  ({ src }, ref) => {
    useEffect(() => {
      if (!ref || typeof ref === "function") return;
      const video = ref.current;

      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(src);
        if (video) {
          hls.attachMedia(video);
        }
        return () => {
          if (video) {
            hls.destroy();
          }
        };
      } else if (video && video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
      }
    }, [src, ref]);

    return (
      <video
        ref={ref}
        className="absolute top-0 left-0 rounded-lg w-full h-full object-cover"
        preload="auto"
        playsInline
        controls={false} // Controls handled by parent
      />
    );
  }
);

export default VideoPlayer;

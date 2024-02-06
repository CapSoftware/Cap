import React, { forwardRef, useEffect } from "react";
import Hls from "hls.js";

interface AudioPlayerProps {
  src: string;
}

export const AudioPlayer = forwardRef<HTMLAudioElement, AudioPlayerProps>(
  ({ src }, ref) => {
    useEffect(() => {
      if (!ref || typeof ref === "function") return;
      const audio = ref.current;

      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(src);
        if (audio) {
          hls.attachMedia(audio);
        }
        return () => {
          if (audio) {
            hls.destroy();
          }
        };
      } else if (audio && audio.canPlayType("application/vnd.apple.mpegurl")) {
        audio.src = src;
      }
    }, [src, ref]);

    return <audio ref={ref} controls={false} style={{ display: "none" }} />;
  }
);

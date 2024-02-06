import React, { useEffect, useRef } from "react";
import Hls from "hls.js";

interface AudioPlayerProps {
  src: string;
  isPlaying: boolean;
  currentTime: number;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  src,
  isPlaying,
  currentTime,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const hls = new Hls({
      autoStartLoad: true,
      enableWorker: true,
      debug: true,
    });
    if (Hls.isSupported()) {
      hls.loadSource(src);
      hls.attachMedia(audio);
    } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
      audio.src = src;
    }

    return () => {
      hls.destroy();
    };
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.play().catch((e) => console.error("Audio playback failed:", e));
    } else {
      audio.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;

    audio.currentTime = currentTime;
  }, [currentTime]);

  return <audio ref={audioRef} controls={false} style={{ display: "none" }} />;
};

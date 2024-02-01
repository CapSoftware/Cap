import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

export function VideoPlayer({
  src,
  isPlaying: isPlayingProp,
  onPlayPause,
}: {
  src: string;
  isPlaying: boolean;
  onPlayPause: (isPlaying: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(isPlayingProp);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
    }

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);

    // Cleanup
    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
    };
  }, [src]);

  useEffect(() => {
    setIsPlaying(isPlayingProp);
  }, [isPlayingProp]);

  useEffect(() => {
    onPlayPause(isPlaying);
  }, [isPlaying, onPlayPause]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      isPlaying ? video.play() : video.pause();
    }
  }, [isPlaying]);

  return (
    <video
      className="w-full h-full object-cover"
      ref={videoRef}
      src={src}
      preload="auto"
    />
  );
}

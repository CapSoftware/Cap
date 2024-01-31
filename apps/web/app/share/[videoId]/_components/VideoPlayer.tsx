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
  // Initialize local playing state based on prop
  const [isPlaying, setIsPlaying] = useState(isPlayingProp);
  const [isLoaded, setIsLoaded] = useState(false);

  const onLoadedData = () => {
    setIsLoaded(true);
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    video.play();
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
    }

    // Synchronize video playback with local state
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleLoadedData = () => onLoadedData();
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("loadeddata", handleLoadedData);

    // Cleanup
    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("loadeddata", handleLoadedData);
    };
  }, [src]);

  useEffect(() => {
    // Synchronize local state with prop when it changes
    setIsPlaying(isPlayingProp);
  }, [isPlayingProp]);

  // Propagate play/pause action upstream
  useEffect(() => {
    onPlayPause(isPlaying);
  }, [isPlaying, onPlayPause]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      isPlaying ? video.play() : video.pause();
    }
  }, [isPlaying]);

  if (!isLoaded) {
    return (
      <div className="w-full h-full object-cover">
        <p>Loading</p>
      </div>
    );
  } else {
    return (
      <video
        className="w-full h-full object-cover"
        ref={videoRef}
        src={src}
        autoPlay={isPlayingProp}
      />
    );
  }
}

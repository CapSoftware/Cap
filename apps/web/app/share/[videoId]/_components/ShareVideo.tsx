import { videos } from "@cap/database/schema";
import { VideoPlayer } from "./VideoPlayer";
import { useState, useEffect, useRef } from "react";
import { Play, Pause, Maximize, VolumeX, Volume2 } from "lucide-react";
import { LogoSpinner } from "@cap/ui";
import { AudioPlayer } from "./AudioPlayer";

const formatTime = (time: number) => {
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
};

export const ShareVideo = ({ data }: { data: typeof videos.$inferSelect }) => {
  const video1Ref = useRef<HTMLVideoElement>(null);
  const video2Ref = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [longestDuration, setLongestDuration] = useState(0);
  const [seeking, setSeeking] = useState(false);

  useEffect(() => {
    const handleLoadedMetadata = () => {
      const duration1 = video1Ref.current?.duration || 0;
      const duration2 = video2Ref.current?.duration || 0;
      setLongestDuration(Math.max(duration1, duration2));
      setIsLoading(!(duration1 > 0 && duration2 > 0));
    };

    video1Ref.current?.addEventListener("loadedmetadata", handleLoadedMetadata);
    video2Ref.current?.addEventListener("loadedmetadata", handleLoadedMetadata);

    return () => {
      video1Ref.current?.removeEventListener(
        "loadedmetadata",
        handleLoadedMetadata
      );
      video2Ref.current?.removeEventListener(
        "loadedmetadata",
        handleLoadedMetadata
      );
    };
  }, []);

  useEffect(() => {
    const handleTimeUpdate = () => {
      if (video1Ref.current && video2Ref.current && !seeking) {
        const currentTime = Math.min(
          video1Ref.current.currentTime,
          video2Ref.current.currentTime
        );
        setCurrentTime(currentTime);
      }
    };

    video1Ref.current?.addEventListener("timeupdate", handleTimeUpdate);
    video2Ref.current?.addEventListener("timeupdate", handleTimeUpdate);

    return () => {
      video1Ref.current?.removeEventListener("timeupdate", handleTimeUpdate);
      video2Ref.current?.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [seeking]);

  const handlePlayPauseClick = () => setIsPlaying(!isPlaying);

  const handleMuteClick = () => {
    const muted = !video1Ref.current?.muted;
    if (video1Ref.current) video1Ref.current.muted = muted;
    if (video2Ref.current) video2Ref.current.muted = muted;
  };

  const handleFullscreenClick = () => {
    const player = document.getElementById("player");
    if (!document.fullscreenElement) {
      player
        ?.requestFullscreen()
        .catch((err) =>
          console.error(
            `Error attempting to enable full-screen mode: ${err.message} (${err.name})`
          )
        );
    } else {
      document.exitFullscreen();
    }
  };

  const handleSeekMouseDown = (event: any) => setSeeking(true);

  const handleSeekMouseUp = (event: any) => {
    if (!seeking) return;
    setSeeking(false);
    const seekBar = event.currentTarget;
    const seekTo = calculateNewTime(event, seekBar);

    // Pause both videos before adjusting the time.
    if (isPlaying) {
      video1Ref.current?.pause();
      video2Ref.current?.pause();
    }

    applyTimeToVideos(seekTo);

    if (isPlaying) {
      video1Ref.current?.play();
      video2Ref.current?.play();
    }
  };

  const handleSeekMouseMove = (event: any) => {
    if (!seeking) return;
    const seekBar = event.currentTarget;
    const seekTo = calculateNewTime(event, seekBar);
    applyTimeToVideos(seekTo);
  };

  const calculateNewTime = (event: any, seekBar: any) => {
    const rect = seekBar.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const relativePosition = offsetX / rect.width;
    return relativePosition * longestDuration;
  };

  const applyTimeToVideos = (time: number) => {
    if (video1Ref.current) video1Ref.current.currentTime = time;
    if (video2Ref.current) video2Ref.current.currentTime = time;
    setCurrentTime(time);
  };

  const watchedPercentage =
    longestDuration > 0 ? (currentTime / longestDuration) * 100 : 0;

  useEffect(() => {
    if (isPlaying) {
      video1Ref.current?.play();
      video2Ref.current?.play();
    } else {
      video1Ref.current?.pause();
      video2Ref.current?.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    const syncPlay = () => {
      if (video1Ref.current && video2Ref.current && !isLoading) {
        const playPromise1 = video1Ref.current.play();
        playPromise1.catch((e) => console.log("Play failed for video 1", e));
        const playPromise2 = video2Ref.current.play();
        playPromise2.catch((e) => console.log("Play failed for video 2", e));
      }
    };

    if (isPlaying) {
      syncPlay();
    }
  }, [isPlaying, isLoading]);

  const onAudioLoaded = (duration: number) => {
    const videoDuration = video1Ref.current?.duration || 0;
    setLongestDuration(Math.max(duration, videoDuration));
  };

  return (
    <div
      className="relative flex h-full w-full overflow-hidden shadow-lg rounded-lg group"
      id="player"
    >
      {isLoading && (
        <div className="absolute top-0 left-0 flex items-center justify-center w-full h-full z-10">
          <LogoSpinner className="w-10 h-auto animate-spin" />
        </div>
      )}
      {isLoading === false && (
        <div
          className={`absolute top-0 left-0 w-full h-full z-10 flex items-center justify-center bg-black bg-opacity-50 transition-all opacity-0 group-hover:opacity-100`}
        >
          <button
            aria-label="Play video"
            className=" w-full h-full flex items-center justify-center text-sm font-medium transition ease-in-out duration-150 text-white border border-transparent px-2 py-2 justify-center rounded-lg"
            tabIndex={0}
            type="button"
            onClick={() => handlePlayPauseClick()}
          >
            {isPlaying ? (
              <Pause className="w-auto h-14 hover:opacity-50" />
            ) : (
              <Play className="w-auto h-14 hover:opacity-50" />
            )}
          </button>
        </div>
      )}
      <AudioPlayer
        src={`${process.env.NEXT_PUBLIC_URL}/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=audio`}
        isPlaying={isPlaying}
        currentTime={currentTime}
      />
      <div className="w-[175px] h-[175px] absolute bottom-4 right-12 overflow-hidden rounded-full z-10 shadow-lg">
        <VideoPlayer
          ref={video1Ref}
          src={`${process.env.NEXT_PUBLIC_URL}/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=video`}
        />
      </div>
      <div
        className="relative block w-full h-full rounded-lg bg-black"
        style={{ paddingBottom: "min(806px, 56.25%)" }}
      >
        <VideoPlayer
          ref={video2Ref}
          src={`${process.env.NEXT_PUBLIC_URL}/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=screen`}
        />
      </div>
      <div className="absolute bottom-0 z-20 w-full text-white bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-all">
        <div
          id="seek"
          className="drag-seek absolute left-0 right-0 block h-4 mx-4 -mt-2 group z-20 cursor-pointer"
          onMouseDown={handleSeekMouseDown}
          onMouseMove={handleSeekMouseMove}
          onMouseUp={handleSeekMouseUp}
          onMouseLeave={() => setSeeking(false)}
          onTouchStart={handleSeekMouseDown}
          onTouchMove={handleSeekMouseMove}
          onTouchEnd={handleSeekMouseUp}
        >
          <div className="absolute top-1.5 w-full h-1 bg-white bg-opacity-50 rounded-full z-0" />
          <div
            className="absolute top-1.5 h-1 bg-white rounded-full cursor-pointer transition-all duration-300 z-0"
            style={{ width: `${watchedPercentage}%` }}
          />
          <div
            className="drag-button absolute top-1.5 z-10 -mt-1.5 -ml-2 w-4 h-4 bg-white rounded-full border border-white cursor-pointer focus:ring-2 focus:ring-indigo-600 focus:ring-opacity-80 focus:outline-none transition-all duration-300"
            tabIndex={0}
            style={{ left: `${watchedPercentage}%` }}
          />
        </div>
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center space-x-3">
            <div>
              <span className="inline-flex">
                <button
                  aria-label="Play video"
                  className=" inline-flex items-center text-sm font-medium transition ease-in-out duration-150 focus:outline-none border text-slate-100 border-transparent hover:text-white focus:border-white hover:bg-slate-100 hover:bg-opacity-10 active:bg-slate-100 active:bg-opacity-10 px-2 py-2 justify-center rounded-lg"
                  tabIndex={0}
                  type="button"
                  onClick={() => handlePlayPauseClick()}
                >
                  {isPlaying ? (
                    <Pause className="w-auto h-6" />
                  ) : (
                    <Play className="w-auto h-6" />
                  )}
                </button>
              </span>
            </div>
            <div className="text-sm text-white font-medium select-none tabular text-clip overflow-hidden whitespace-nowrap space-x-0.5">
              {formatTime(currentTime)} - {formatTime(longestDuration)}
            </div>
          </div>
          <div className="flex justify-end space-x-2">
            <div className="flex items-center justify-end space-x-2">
              <span className="inline-flex">
                <button
                  aria-label="Mute video"
                  className=" inline-flex items-center text-sm font-medium transition ease-in-out duration-150 focus:outline-none border text-slate-100 border-transparent hover:text-white focus:border-white hover:bg-slate-100 hover:bg-opacity-10 active:bg-slate-100 active:bg-opacity-10 px-2 py-2 justify-center rounded-lg"
                  tabIndex={0}
                  type="button"
                  onClick={() => handleMuteClick()}
                >
                  {video1Ref?.current?.muted && video2Ref?.current?.muted ? (
                    <VolumeX className="w-auto h-6" />
                  ) : (
                    <Volume2 className="w-auto h-6" />
                  )}
                </button>
              </span>
              <span className="inline-flex">
                <button
                  aria-label="Go fullscreen"
                  className=" inline-flex items-center text-sm font-medium transition ease-in-out duration-150 focus:outline-none border text-slate-100 border-transparent hover:text-white focus:border-white hover:bg-slate-100 hover:bg-opacity-10 active:bg-slate-100 active:bg-opacity-10 px-2 py-2 justify-center rounded-lg"
                  tabIndex={0}
                  type="button"
                  onClick={handleFullscreenClick}
                >
                  <Maximize className="w-auto h-6" />
                </button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

import { videos } from "@cap/database/schema";
import { VideoPlayer } from "./VideoPlayer";
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Play, Pause, Maximize, VolumeX, Volume2 } from "lucide-react";
import { LogoSpinner } from "@cap/ui";

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
  const [duration1, setDuration1] = useState(0);
  const [duration2, setDuration2] = useState(0);
  const [longestDuration, setLongestDuration] = useState(0);

  useEffect(() => {
    const handleLoadedMetadata = () => {
      const loadedDuration1 = video1Ref.current?.duration || 0;
      const loadedDuration2 = video2Ref.current?.duration || 0;
      setDuration1(loadedDuration1);
      setDuration2(loadedDuration2);
      setLongestDuration(Math.max(loadedDuration1, loadedDuration2));

      if (loadedDuration1 > 0 && loadedDuration2 > 0) {
        setIsLoading(false); // Set loading to false once both videos' metadata are loaded
      }
    };

    const handleTimeUpdate = () => {
      if (video1Ref.current) {
        setCurrentTime(video1Ref.current.currentTime);
      }
    };

    const videos = [video1Ref.current, video2Ref.current].filter(Boolean);
    videos.forEach((video) => {
      video?.addEventListener("loadedmetadata", handleLoadedMetadata);
      video?.addEventListener("timeupdate", handleTimeUpdate);
    });

    return () => {
      videos.forEach((video) => {
        video?.removeEventListener("loadedmetadata", handleLoadedMetadata);
        video?.removeEventListener("timeupdate", handleTimeUpdate);
      });
    };
  }, []);

  const handlePlayPauseClick = () => setIsPlaying(!isPlaying);

  const handleMuteClick = () => {
    if (!video1Ref.current || !video2Ref.current) return;

    video1Ref.current.muted = !video1Ref.current.muted;
    video2Ref.current.muted = !video2Ref.current.muted;
  };

  const handleFullscreenClick = () => {
    const player = document.getElementById("player");
    if (player) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        player.requestFullscreen();
      }
    }
  };

  const watchedPercentage =
    longestDuration > 0 ? (currentTime / longestDuration) * 100 : 0;

  const handlePlay = () => {
    video1Ref.current?.play();
    video2Ref.current?.play();
  };

  useEffect(() => {
    if (!isLoading && isPlaying) {
      video1Ref.current?.play();
      video2Ref.current?.play();
    } else {
      video1Ref.current?.pause();
      video2Ref.current?.pause();
    }
  }, [isLoading, isPlaying]);

  //Play on load
  useEffect(() => {
    if (!isLoading) {
      handlePlay();
    }
  }, [isLoading]);

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
            className=" inline-flex items-center text-sm font-medium transition ease-in-out duration-150 text-white border border-transparent hover:opacity-50 px-2 py-2 justify-center rounded-lg"
            tabIndex={0}
            type="button"
            onClick={() => handlePlayPauseClick()}
          >
            {isPlaying ? (
              <Pause className="w-auto h-14" />
            ) : (
              <Play className="w-auto h-14" />
            )}
          </button>
        </div>
      )}
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
          className="absolute left-0 right-0 block h-4 mx-4 -mt-2 group"
        >
          <div className="absolute top-1.5 w-full h-1 bg-white bg-opacity-50 rounded-full cursor-pointer" />
          <div
            className="absolute top-1.5 h-1 bg-white rounded-full cursor-pointer transition-all duration-300"
            style={{ width: `${watchedPercentage}%` }}
          />
          <div
            className="absolute top-1.5 z-10 -mt-1.5 -ml-2 w-4 h-4 bg-white rounded-full border border-white cursor-pointer focus:ring-2 focus:ring-indigo-600 focus:ring-opacity-80 focus:outline-none transition-all duration-300"
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
                  onClick={handleMuteClick}
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

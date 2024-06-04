import { comments as commentsSchema, videos } from "@cap/database/schema";
import { VideoPlayer } from "./VideoPlayer";
import { useState, useEffect, useRef } from "react";
import {
  Play,
  Pause,
  Maximize,
  VolumeX,
  Volume2,
  MessageSquare,
} from "lucide-react";
import { LogoSpinner } from "@cap/ui";
import { userSelectProps } from "@cap/database/auth/session";
import { Tooltip } from "react-tooltip";

declare global {
  interface Window {
    MSStream: any;
  }
}

const formatTime = (time: number) => {
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
};

export const ShareVideo = ({
  data,
  user,
  comments,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
  comments: (typeof commentsSchema.$inferSelect)[];
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [longestDuration, setLongestDuration] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [videoMetadataLoaded, setVideoMetadataLoaded] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const overlayTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleMouseMove = () => {
      setOverlayVisible(true);
      if (overlayTimeoutRef.current) {
        clearTimeout(overlayTimeoutRef.current);
      }
      overlayTimeoutRef.current = setTimeout(() => {
        setOverlayVisible(false);
      }, 1000);
    };

    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (overlayTimeoutRef.current) {
        clearTimeout(overlayTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (videoMetadataLoaded) {
      console.log("Metadata loaded");
      setIsLoading(false);
    }
  }, [videoMetadataLoaded]);

  useEffect(() => {
    const onVideoLoadedMetadata = () => {
      console.log("Video metadata loaded");
      setVideoMetadataLoaded(true);
      if (videoRef.current) {
        setLongestDuration(videoRef.current.duration);
      }
    };

    const videoElement = videoRef.current;

    videoElement?.addEventListener("loadedmetadata", onVideoLoadedMetadata);

    return () => {
      videoElement?.removeEventListener(
        "loadedmetadata",
        onVideoLoadedMetadata
      );
    };
  }, []);

  const handlePlayPauseClick = async () => {
    const videoElement = videoRef.current;

    if (!videoElement) return;

    if (isPlaying) {
      videoElement.pause();
      setIsPlaying(false);
    } else {
      try {
        await videoElement.play();
        setIsPlaying(true);
        videoElement.muted = false;
      } catch (error) {
        console.error("Error with playing:", error);
      }
    }
  };

  const applyTimeToVideos = (time: number) => {
    if (videoRef.current) videoRef.current.currentTime = time;
    setCurrentTime(time);
  };

  useEffect(() => {
    const syncPlayback = () => {
      const videoElement = videoRef.current;

      if (!isPlaying || isLoading || !videoElement) return;

      const handleTimeUpdate = () => {
        setCurrentTime(videoElement.currentTime);
      };

      videoElement.play().catch((error) => {
        console.error("Error playing video", error);
        setIsPlaying(false);
      });
      videoElement.addEventListener("timeupdate", handleTimeUpdate);

      return () =>
        videoElement.removeEventListener("timeupdate", handleTimeUpdate);
    };

    syncPlayback();
  }, [isPlaying, isLoading]);

  useEffect(() => {
    const handleSeeking = () => {
      if (seeking && videoRef.current) {
        setCurrentTime(videoRef.current.currentTime);
      }
    };

    const videoElement = videoRef.current;

    videoElement?.addEventListener("seeking", handleSeeking);

    return () => {
      videoElement?.removeEventListener("seeking", handleSeeking);
    };
  }, [seeking]);

  const calculateNewTime = (event: any, seekBar: any) => {
    const rect = seekBar.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const relativePosition = offsetX / rect.width;
    return relativePosition * longestDuration;
  };

  const handleSeekMouseDown = () => {
    setSeeking(true);
  };

  const handleSeekMouseUp = (event: any) => {
    if (!seeking) return;
    setSeeking(false);
    const seekBar = event.currentTarget;
    const seekTo = calculateNewTime(event, seekBar);
    applyTimeToVideos(seekTo);
    if (isPlaying) {
      videoRef.current?.play();
    }
  };

  const handleSeekMouseMove = (event: any) => {
    if (!seeking) return;
    const seekBar = event.currentTarget;
    const seekTo = calculateNewTime(event, seekBar);
    applyTimeToVideos(seekTo);
  };

  const handleMuteClick = () => {
    if (videoRef.current) {
      console.log("Mute clicked");
      videoRef.current.muted = videoRef.current.muted ? false : true;
    }
  };

  const handleFullscreenClick = () => {
    const player = document.getElementById("player");
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    if (!document.fullscreenElement && !isIOS) {
      player
        ?.requestFullscreen()
        .catch((err) =>
          console.error(
            `Error attempting to enable full-screen mode: ${err.message} (${err.name})`
          )
        );
    } else if (isIOS && videoRef.current) {
      const videoUrl = videoRef.current.src;
      window.open(videoUrl, "_blank");
    } else {
      document.exitFullscreen();
    }
  };

  const watchedPercentage =
    longestDuration > 0 ? (currentTime / longestDuration) * 100 : 0;

  useEffect(() => {
    if (isPlaying) {
      videoRef.current?.play();
    } else {
      videoRef.current?.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    const syncPlay = () => {
      if (videoRef.current && !isLoading) {
        const playPromise2 = videoRef.current.play();
        playPromise2.catch((e) => console.log("Play failed for video 2", e));
      }
    };

    if (isPlaying) {
      syncPlay();
    }
  }, [isPlaying, isLoading]);

  if (data.jobStatus === "ERROR") {
    return (
      <div className="flex items-center justify-center w-full h-full rounded-lg overflow-hidden">
        <div
          style={{ paddingBottom: "min(806px, 56.25%)" }}
          className="relative w-full h-full rounded-lg bg-black flex items-center justify-center p-8"
        >
          <p className="text-white text-xl">
            There was an error when processing the video. Please contact
            support.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full w-full overflow-hidden shadow-lg rounded-lg group"
      id="player"
    >
      {isLoading && (
        <div className="absolute top-0 left-0 flex flex-col items-center justify-center w-full h-full z-10">
          <LogoSpinner className="w-10 h-auto animate-spin" />
        </div>
      )}
      {isLoading === false && (
        <div
          className={`absolute top-0 left-0 w-full h-full z-10 flex items-center justify-center bg-black bg-opacity-50 transition-all opacity-0 ${
            overlayVisible && "group-hover:opacity-100"
          } z-20`}
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
      <div
        className="relative block w-full h-full rounded-lg bg-black"
        style={{ paddingBottom: "min(806px, 56.25%)" }}
      >
        <VideoPlayer
          ref={videoRef}
          videoSrc={
            data.skipProcessing === true || data.jobStatus !== "COMPLETE"
              ? `${process.env.NEXT_PUBLIC_URL}/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=master`
              : `https://v.cap.so/${data.ownerId}/${data.id}/output/video_recording_000.m3u8`
          }
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
          onTouchEnd={handleSeekMouseUp}
        >
          {!isLoading && comments !== null && (
            <div className="w-full -mt-7 md:-mt-6">
              {comments.map((comment) => {
                if (comment.timestamp === null) return null;

                return (
                  <div
                    key={comment.id}
                    className="absolute z-10 text-[16px] hover:scale-125 transition-all"
                    style={{
                      left: `${(comment.timestamp / longestDuration) * 100}%`,
                    }}
                    data-tooltip-id={comment.id}
                    data-tooltip-content={`${
                      comment.type === "text"
                        ? "User: " + comment.content
                        : comment.authorId === "anonymous"
                        ? "Anonymous"
                        : "User"
                    }`}
                  >
                    <Tooltip id={comment.id} />
                    <span>
                      {comment.type === "text" ? (
                        <MessageSquare
                          fill="#646464"
                          className="w-auto h-[22px] text-white"
                        />
                      ) : (
                        comment.content
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="absolute top-1.5 w-full h-1.5 bg-white bg-opacity-50 rounded-full z-10" />
          <div
            className="absolute top-1.5 h-1.5 bg-white rounded-full cursor-pointer transition-all duration-300 z-10"
            style={{ width: `${watchedPercentage}%` }}
          />
          <div
            className="drag-button absolute top-1.5 z-20 -mt-1.5 -ml-2 w-4 h-4 bg-white rounded-full border border-white cursor-pointer focus:ring-2 focus:ring-indigo-600 focus:ring-opacity-80 focus:outline-none transition-all duration-300"
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
                  {videoRef?.current?.muted ? (
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

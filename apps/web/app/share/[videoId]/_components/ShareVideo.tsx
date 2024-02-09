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
  const video2Ref = useRef<HTMLVideoElement>(null);
  const audioPlayerRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [longestDuration, setLongestDuration] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [videoMetadataLoaded, setVideoMetadataLoaded] = useState(false);
  const [audioMetadataLoaded, setAudioMetadataLoaded] = useState(false);

  useEffect(() => {
    const adjustForStartTimes = () => {
      if (!video2Ref.current || !audioPlayerRef.current) return;
      console.log("Adjusting start times");

      const videoStartTime = data.videoStartTime
        ? new Date(data.videoStartTime).getTime()
        : 0;
      const audioStartTime = data.audioStartTime
        ? new Date(data.audioStartTime).getTime()
        : 0;

      const timeDifference = videoStartTime - audioStartTime;

      console.log("Time difference", timeDifference);

      if (timeDifference > 0) {
        audioPlayerRef.current.currentTime = timeDifference / 1000;
        video2Ref.current.currentTime = 0; // Ensure video starts from the beginning
      } else if (timeDifference < 0) {
        video2Ref.current.currentTime = Math.abs(timeDifference / 1000);
        audioPlayerRef.current.currentTime = 0; // Ensure audio starts from the beginning
      }

      const videoLength = video2Ref.current.duration;
      const audioLength = audioPlayerRef.current.duration;

      const lengthDifference = Math.abs(videoLength - audioLength);

      if (lengthDifference > 0) {
        console.log("Length difference detected");

        if (videoLength > audioLength) {
          video2Ref.current.currentTime =
            video2Ref.current.currentTime - lengthDifference;
        } else {
          audioPlayerRef.current.currentTime =
            audioPlayerRef.current.currentTime - lengthDifference;
        }
      }

      console.log("refs:");
      console.log(video2Ref.current.currentTime);
      console.log(audioPlayerRef.current.currentTime);

      console.log("Start times adjusted");
      setIsLoading(false);
    };

    if (videoMetadataLoaded && audioMetadataLoaded) {
      adjustForStartTimes();
    }
  }, [
    videoMetadataLoaded,
    audioMetadataLoaded,
    data.videoStartTime,
    data.audioStartTime,
  ]);

  useEffect(() => {
    const onVideoLoadedMetadata = () => {
      setVideoMetadataLoaded(true);
      if (video2Ref.current) {
        setLongestDuration(video2Ref.current.duration);
      }
    };
    const onAudioLoadedMetadata = () => {
      setAudioMetadataLoaded(true);
      if (audioPlayerRef.current) {
        setLongestDuration(
          Math.max(longestDuration, audioPlayerRef.current.duration)
        );
      }
    };

    const videoElement = video2Ref.current;
    const audioElement = audioPlayerRef.current;

    videoElement?.addEventListener("loadedmetadata", onVideoLoadedMetadata);
    audioElement?.addEventListener("loadedmetadata", onAudioLoadedMetadata);

    return () => {
      videoElement?.removeEventListener(
        "loadedmetadata",
        onVideoLoadedMetadata
      );
      audioElement?.removeEventListener(
        "loadedmetadata",
        onAudioLoadedMetadata
      );
    };
  }, []);

  useEffect(() => {
    const handleTimeUpdate = () => {
      if (video2Ref.current && !seeking) {
        const currentTime = Math.min(
          video2Ref.current.currentTime,
          audioPlayerRef.current?.currentTime || Infinity
        );
        setCurrentTime(currentTime);
      }
    };

    const videoElement = video2Ref.current;
    const audioElement = audioPlayerRef.current;

    videoElement?.addEventListener("timeupdate", handleTimeUpdate);
    audioElement?.addEventListener("timeupdate", handleTimeUpdate);

    return () => {
      videoElement?.removeEventListener("timeupdate", handleTimeUpdate);
      audioElement?.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [seeking]);

  const handlePlayPauseClick = () => {
    setIsPlaying(!isPlaying);
    if (!isPlaying) {
      video2Ref.current?.play();
      audioPlayerRef.current?.play();
    } else {
      video2Ref.current?.pause();
      audioPlayerRef.current?.pause();
    }
  };

  const handleMuteClick = () => {
    const muted = !video2Ref.current?.muted;
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
      video2Ref.current?.pause();
    }

    applyTimeToVideos(seekTo);

    if (isPlaying) {
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
    if (video2Ref.current) video2Ref.current.currentTime = time;
    setCurrentTime(time);
  };

  const watchedPercentage =
    longestDuration > 0 ? (currentTime / longestDuration) * 100 : 0;

  useEffect(() => {
    if (isPlaying) {
      video2Ref.current?.play();
    } else {
      video2Ref.current?.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    const syncPlay = () => {
      if (video2Ref.current && !isLoading) {
        const playPromise2 = video2Ref.current.play();
        playPromise2.catch((e) => console.log("Play failed for video 2", e));
      }
    };

    if (isPlaying) {
      syncPlay();
    }
  }, [isPlaying, isLoading]);

  // useEffect(() => {
  //   const video = video2Ref.current;
  //   const audio = audioPlayerRef.current;

  //   // Function to synchronize audio playback with video
  //   const synchronizePlayback = () => {
  //     if (!video || !audio) return;

  //     // Calculate the time drift between audio and video
  //     const drift = Math.abs(video.currentTime - audio.currentTime);

  //     // Adjust audio currentTime if drift exceeds a small tolerance (e.g., 0.1 seconds)
  //     if (drift > 0.1) {
  //       audio.currentTime = video.currentTime;
  //     }
  //   };

  //   // Sync audio on video seek
  //   const handleSeek = () => {
  //     synchronizePlayback(); // Adjust audio to match video currentTime
  //     if (isPlaying) {
  //       audio?.play().catch((e) => console.error("Audio playback failed:", e)); // Ensure audio resumes if it was playing
  //     }
  //   };

  //   // Add event listeners
  //   video?.addEventListener("seeked", handleSeek);
  //   video?.addEventListener("timeupdate", synchronizePlayback);

  //   // Cleanup event listeners
  //   return () => {
  //     if (video) {
  //       video.removeEventListener("seeked", handleSeek);
  //       video.removeEventListener("timeupdate", synchronizePlayback);
  //     }
  //   };
  // }, [isPlaying]);

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
          className={`absolute top-0 left-0 w-full h-full z-10 flex items-center justify-center bg-black bg-opacity-50 transition-all opacity-0 group-hover:opacity-100 z-20`}
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
        ref={audioPlayerRef}
        src={`${process.env.NEXT_PUBLIC_URL}/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=audio`}
      />
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
                  {video2Ref?.current?.muted ? (
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

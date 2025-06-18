import { UpgradeModal } from "@/components/UpgradeModal";
import { usePublicEnv } from "@/utils/public-env";
import { useApiClient } from "@/utils/web-api";
import { useTranscript } from "hooks/use-transcript";
import { userSelectProps } from "@cap/database/auth/session";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { NODE_ENV } from "@cap/env";
import { Logo, LogoSpinner } from "@cap/ui";
import { isUserOnProPlan } from "@cap/utils";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import {
  Maximize,
  MessageSquare,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  use,
  Suspense,
} from "react";
import { Tooltip } from "react-tooltip";
import { toast } from "sonner";
import { fromVtt, Subtitle } from "subtitles-parser-vtt";
import { MP4VideoPlayer } from "./MP4VideoPlayer";
import { VideoPlayer } from "./VideoPlayer";
import { useQuery } from "@tanstack/react-query";

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

const formatTimeWithMilliseconds = (time: number) => {
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  const milliseconds = Math.floor((time % 1) * 100);
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}.${milliseconds.toString().padStart(2, "0")}`;
};

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
  authorName: string | null;
};

export const ShareVideo = forwardRef<
  HTMLVideoElement,
  {
    data: typeof videos.$inferSelect;
    user: typeof userSelectProps | null;
    comments: MaybePromise<CommentWithAuthor[]>;
    chapters?: { title: string; start: number }[];
    aiProcessing?: boolean;
  }
>(({ data, user, comments, chapters = [], aiProcessing = false }, ref) => {
  useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

  const videoRef = useRef<HTMLVideoElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [longestDuration, setLongestDuration] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [videoMetadataLoaded, setVideoMetadataLoaded] = useState(false);
  const [videoReadyToPlay, setVideoReadyToPlay] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [subtitlesVisible, setSubtitlesVisible] = useState(true);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [tempOverlayVisible, setTempOverlayVisible] = useState(false);

  const [showPreview, setShowPreview] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewPosition, setPreviewPosition] = useState(0);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(200);
  const [previewHeight, setPreviewHeight] = useState(112);
  const [isMP4Source, setIsMP4Source] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  const [videoSpeed, setVideoSpeed] = useState(1);
  const [isHoveringVideo, setIsHoveringVideo] = useState(false);
  const [isHoveringControls, setIsHoveringControls] = useState(false);
  const hideControlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [userMuted, setUserMuted] = useState(false);

  const [scrubbingVideo, setScrubbingVideo] = useState<HTMLVideoElement | null>(
    null
  );

  const [isPreviewSeeking, setIsPreviewSeeking] = useState(false);
  const lastUpdateTimeRef = useRef<number>(0);
  const lastMousePosRef = useRef<number>(0);

  const isLargeScreen = useScreenSize();

  // Use TanStack Query for video source validation
  const { data: videoSourceData } = useVideoSourceValidation(
    data,
    videoMetadataLoaded
  );

  // Update isMP4Source based on query result
  useEffect(() => {
    if (videoSourceData) {
      setIsMP4Source(videoSourceData.isMP4Source);
    } else if (videoMetadataLoaded) {
      setIsMP4Source(data.source.type === "desktopMP4");
    }
  }, [videoSourceData, videoMetadataLoaded, data.source.type]);

  useEffect(() => {
    if (videoRef.current) {
      if (typeof ref === "function") {
        ref(videoRef.current);
      } else if (ref) {
        ref.current = videoRef.current;
      }
    }
  }, [ref]);

  const showControls = () => {
    setOverlayVisible(true);
    if (hideControlsTimeoutRef.current) {
      clearTimeout(hideControlsTimeoutRef.current);
      hideControlsTimeoutRef.current = null;
    }
  };

  const scheduleHideControls = () => {
    if (hideControlsTimeoutRef.current) {
      clearTimeout(hideControlsTimeoutRef.current);
    }

    if (isPlaying && !isHoveringControls) {
      hideControlsTimeoutRef.current = setTimeout(() => {
        setOverlayVisible(false);
      }, 1000);
    }
  };

  useEffect(() => {
    const handleMouseMove = () => {
      showControls();
      scheduleHideControls();
    };

    const handleMouseEnter = () => {
      setIsHoveringVideo(true);
      showControls();
    };

    const handleMouseLeave = () => {
      setIsHoveringVideo(false);
      if (!isHoveringControls) {
        scheduleHideControls();
      }
    };

    const videoContainer = document.getElementById("video-container");
    if (videoContainer) {
      videoContainer.addEventListener("mousemove", handleMouseMove);
      videoContainer.addEventListener("mouseenter", handleMouseEnter);
      videoContainer.addEventListener("mouseleave", handleMouseLeave);
    }

    return () => {
      if (videoContainer) {
        videoContainer.removeEventListener("mousemove", handleMouseMove);
        videoContainer.removeEventListener("mouseenter", handleMouseEnter);
        videoContainer.removeEventListener("mouseleave", handleMouseLeave);
      }
      if (hideControlsTimeoutRef.current) {
        clearTimeout(hideControlsTimeoutRef.current);
      }
    };
  }, [isPlaying, isHoveringControls]);

  useEffect(() => {
    if (isPlaying) {
      scheduleHideControls();
    } else {
      showControls();
    }
  }, [isPlaying, isHoveringControls]);

  useEffect(() => {
    if (isHoveringControls) {
      showControls();
    } else if (isPlaying && !isHoveringVideo) {
      scheduleHideControls();
    }
  }, [isHoveringControls, isPlaying, isHoveringVideo]);

  useEffect(() => {
    const handleShortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isFormElement =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable ||
        target.getAttribute("role") === "textbox";

      if (!isFormElement && videoRef.current) {
        if (e.code === "Space") {
          e.preventDefault();
          if (isPlaying) {
            videoRef.current.pause();
            setIsPlaying(false);
          } else {
            videoRef.current.play();
            setIsPlaying(true);
          }
        }
      }
    };

    window.addEventListener("keydown", handleShortcuts);

    return () => {
      window.removeEventListener("keydown", handleShortcuts);
    };
  }, [isPlaying, videoRef]);

  useEffect(() => {
    const onVideoLoadedMetadata = () => {
      if (videoRef.current) {
        setLongestDuration(videoRef.current.duration);
        setVideoMetadataLoaded(true);
      }
    };

    const onCanPlay = () => {
      setVideoMetadataLoaded(true);
      setVideoReadyToPlay(true);

      setTimeout(() => {
        setIsLoading(false);
      }, 100);
    };

    const videoElement = videoRef.current;
    if (videoElement) {
      videoElement.addEventListener("loadedmetadata", onVideoLoadedMetadata);
      videoElement.addEventListener("canplay", onCanPlay);
    }

    return () => {
      if (videoElement) {
        videoElement.removeEventListener(
          "loadedmetadata",
          onVideoLoadedMetadata
        );
        videoElement.removeEventListener("canplay", onCanPlay);
      }
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
        if (!videoReadyToPlay) {
          setIsPlaying(true);
        } else {
          if (!userMuted) {
            videoElement.muted = false;
          }

          const currentPosition = videoElement.currentTime;

          const playPromise = videoElement.play();

          if (playPromise !== undefined) {
            playPromise
              .then(() => {
                setIsPlaying(true);

                if (videoElement.currentTime === 0 && currentPosition > 0) {
                  videoElement.currentTime = currentPosition;
                }
              })
              .catch((error) => {
                console.error("Error with playing:", error);

                if (error.name === "NotAllowedError") {
                  videoElement.muted = true;
                  videoElement
                    .play()
                    .then(() => {
                      setIsPlaying(true);
                      if (!userMuted) {
                        setTimeout(() => {
                          videoElement.muted = false;
                        }, 100);
                      }

                      if (
                        videoElement.currentTime === 0 &&
                        currentPosition > 0
                      ) {
                        videoElement.currentTime = currentPosition;
                      }
                    })
                    .catch((innerError) => {
                      console.error(
                        "Still can't play even with muted:",
                        innerError
                      );
                    });
                }
              });
          } else {
            setIsPlaying(true);

            if (videoElement.currentTime === 0 && currentPosition > 0) {
              videoElement.currentTime = currentPosition;
            }
          }
        }
      } catch (error) {
        console.error("Error with playing:", error);
      }
    }
  };

  const applyTimeToVideos = (time: number) => {
    if (!Number.isFinite(time)) {
      console.warn("Attempted to set non-finite time:", time);
      return;
    }
    const validTime = Math.max(0, Math.min(time, longestDuration));

    if (videoRef.current && videoRef.current.readyState >= 2) {
      try {
        const video = videoRef.current;
        video.currentTime = validTime;

        const handleSeeked = () => {
          setCurrentTime(video.currentTime);
          video.removeEventListener("seeked", handleSeeked);
        };

        video.addEventListener("seeked", handleSeeked);

        setTimeout(() => {
          video.removeEventListener("seeked", handleSeeked);
        }, 1000);
      } catch (error) {
        console.error("Error setting video currentTime:", error);
      }
    }
  };

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !videoReadyToPlay) return;

    const handleTimeUpdate = () => {
      setCurrentTime(videoElement.currentTime);
    };

    videoElement.addEventListener("timeupdate", handleTimeUpdate);
    const handleEnded = () => {
      setIsPlaying(false);
    };
    videoElement.addEventListener("ended", handleEnded);

    return () => {
      videoElement.removeEventListener("timeupdate", handleTimeUpdate);
      videoElement.removeEventListener("ended", handleEnded);
    };
  }, [videoReadyToPlay]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !videoReadyToPlay) return;

    if (isPlaying) {
      if (!seeking) {
        videoElement.play().catch((error) => {
          console.error("Error playing video", error);
          setIsPlaying(false);
        });
      }
    } else {
      videoElement.pause();
    }
  }, [isPlaying, videoReadyToPlay, seeking]);

  useEffect(() => {
    const handleSeeking = () => {
      if (seeking && videoRef.current) {
        setCurrentTime(videoRef.current.currentTime);
      }
    };

    const preventScroll = (e: TouchEvent) => {
      if (seeking) {
        e.preventDefault();
      }
    };

    const videoElement = videoRef.current;

    if (!videoElement) return;

    videoElement.addEventListener("seeking", handleSeeking);
    window.addEventListener("touchmove", preventScroll, { passive: false });

    return () => {
      videoElement.removeEventListener("seeking", handleSeeking);
      window.removeEventListener("touchmove", preventScroll);
    };
  }, [seeking]);

  useEffect(() => {
    setTempOverlayVisible(true);

    const timer = setTimeout(() => {
      setTempOverlayVisible(false);
    }, 500);

    return () => clearTimeout(timer);
  }, [isPlaying]);

  useEffect(() => {
    if (isMP4Source && data && isLargeScreen) {
      const scrubVideo = document.createElement("video");

      const mp4Source = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=mp4`;

      scrubVideo.src = mp4Source;
      scrubVideo.crossOrigin = "anonymous";
      scrubVideo.preload = "auto";
      scrubVideo.muted = true;
      scrubVideo.style.display = "none";

      scrubVideo.addEventListener("loadedmetadata", () => {
        scrubVideo.currentTime = 0;
      });

      scrubVideo.addEventListener("canplay", () => {
        setScrubbingVideo(scrubVideo);

        if (previewCanvasRef.current) {
          const canvas = previewCanvasRef.current;
          const ctx = canvas.getContext("2d");

          if (ctx) {
            if (
              canvas.width !== previewWidth ||
              canvas.height !== previewHeight
            ) {
              canvas.width = previewWidth;
              canvas.height = previewHeight;
            }

            try {
              ctx.drawImage(scrubVideo, 0, 0, canvas.width, canvas.height);
              setPreviewLoaded(true);
            } catch (err) {
              console.error("Error preloading initial frame:", err);
            }
          }
        }
      });

      scrubVideo.addEventListener("error", (e) => {
        console.error("Error loading scrubbing video:", e);
      });

      document.body.appendChild(scrubVideo);

      return () => {
        scrubVideo.remove();
        setScrubbingVideo(null);
      };
    } else if (!isLargeScreen) {
      setScrubbingVideo(null);
    }
  }, [isMP4Source, data, previewWidth, previewHeight, isLargeScreen]);

  const updatePreviewFrame = (time: number) => {
    if (!isLargeScreen) return;

    if (!isMP4Source) return;
    setPreviewTime(time);

    if (isPreviewSeeking) {
      return;
    }

    try {
      if (scrubbingVideo && previewCanvasRef.current) {
        const canvas = previewCanvasRef.current;
        const ctx = canvas.getContext("2d");

        if (ctx) {
          if (
            canvas.width !== previewWidth ||
            canvas.height !== previewHeight
          ) {
            canvas.width = previewWidth;
            canvas.height = previewHeight;
          }

          setIsPreviewSeeking(true);

          scrubbingVideo.currentTime = time;

          const handleSeeked = () => {
            try {
              ctx.drawImage(scrubbingVideo, 0, 0, canvas.width, canvas.height);

              ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
              ctx.fillRect(0, canvas.height - 20, canvas.width, 20);
              ctx.fillStyle = "white";
              ctx.font = "12px Arial";
              ctx.textAlign = "center";
              ctx.fillText(
                formatTime(time),
                canvas.width / 2,
                canvas.height - 6
              );

              setPreviewLoaded(true);
              setIsPreviewSeeking(false);
            } catch (err) {
              console.error("Error drawing frame:", err);
              setIsPreviewSeeking(false);
            }

            scrubbingVideo.removeEventListener("seeked", handleSeeked);
          };

          scrubbingVideo.addEventListener("seeked", handleSeeked);

          const timeoutId = setTimeout(() => {
            if (isPreviewSeeking) {
              try {
                ctx.drawImage(
                  scrubbingVideo,
                  0,
                  0,
                  canvas.width,
                  canvas.height
                );

                ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
                ctx.fillRect(0, canvas.height - 20, canvas.width, 20);
                ctx.fillStyle = "white";
                ctx.font = "12px Arial";
                ctx.textAlign = "center";
                ctx.fillText(
                  formatTime(time),
                  canvas.width / 2,
                  canvas.height - 6
                );

                setPreviewLoaded(true);
              } catch (err) {
                console.error("Error drawing frame after timeout:", err);
              } finally {
                setIsPreviewSeeking(false);
                scrubbingVideo.removeEventListener("seeked", handleSeeked);
              }
            }
          }, 250);

          return () => clearTimeout(timeoutId);
        }
      } else if (videoRef.current && previewCanvasRef.current) {
        const canvas = previewCanvasRef.current;
        const video = videoRef.current;
        const ctx = canvas.getContext("2d");

        if (ctx) {
          try {
            canvas.width = previewWidth;
            canvas.height = previewHeight;

            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
            ctx.fillRect(0, canvas.height - 20, canvas.width, 20);
            ctx.fillStyle = "white";
            ctx.font = "12px Arial";
            ctx.textAlign = "center";
            ctx.fillText(formatTime(time), canvas.width / 2, canvas.height - 6);

            setPreviewLoaded(true);
          } catch (err) {
            console.error("Error in fallback video capture:", err);
          }
        }
      }
    } catch (err) {
      console.error("Error updating preview frame:", err);
      setIsPreviewSeeking(false);
    }
  };

  const handleTimelineHover = (
    event: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>
  ) => {
    if (isLoading) return;

    if (!isLargeScreen) return;

    const seekBar = event.currentTarget;
    const time = calculateNewTime(event, seekBar);

    const rect = seekBar.getBoundingClientRect();

    let clientX = 0;
    if ("touches" in event && event.touches && event.touches[0]) {
      clientX = event.touches[0].clientX;
    } else if ("clientX" in event) {
      clientX = event.clientX;
    }

    const previewPos = clientX - rect.left - previewWidth / 2;

    const maxLeft = rect.width - previewWidth;
    const boundedPos = Math.max(0, Math.min(previewPos, maxLeft));

    setPreviewPosition(boundedPos);

    if (!showPreview) {
      setShowPreview(true);
      updatePreviewFrame(time);
      lastUpdateTimeRef.current = Date.now();
      return;
    }

    const currentMousePos = clientX;
    const lastMousePos = lastMousePosRef.current;
    lastMousePosRef.current = currentMousePos;

    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateTimeRef.current;
    const significantMouseMove = Math.abs(currentMousePos - lastMousePos) > 10;

    if (
      !isPreviewSeeking &&
      (timeSinceLastUpdate >= 500 || significantMouseMove)
    ) {
      updatePreviewFrame(time);
      lastUpdateTimeRef.current = now;
    }
  };

  const calculateNewTime = (event: any, seekBar: any) => {
    if (!longestDuration || longestDuration <= 0) {
      return 0;
    }

    const rect = seekBar.getBoundingClientRect();

    if (rect.width <= 0) {
      return 0;
    }

    let clientX = 0;
    if (event.touches && event.touches.length > 0) {
      clientX = event.touches[0].clientX;
    } else if (typeof event.clientX === "number") {
      clientX = event.clientX;
    }

    const offsetX = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const relativePosition = offsetX / rect.width;
    const newTime = Math.max(
      0,
      Math.min(relativePosition * longestDuration, longestDuration)
    );

    return newTime;
  };

  const handleSeekMouseDown = () => {
    if (videoRef.current && videoRef.current.readyState >= 2) {
      setSeeking(true);
    }
  };

  const handleSeekMouseUp = (
    event: React.MouseEvent | React.TouchEvent,
    isTouch = false
  ) => {
    if (!seeking) return;
    setSeeking(false);
    const seekBar = event.currentTarget;
    const seekTo = calculateNewTime(event, seekBar);

    applyTimeToVideos(seekTo);

    if (isPlaying && videoRef.current) {
      setTimeout(() => {
        videoRef.current?.play().catch((error) => {
          console.error("Error resuming playback after seek:", error);
        });
      }, 100);
    }
    setShowPreview(false);
  };

  const handleSeekMouseMove = (event: React.MouseEvent | React.TouchEvent) => {
    if (!seeking) return;

    const seekBar = event.currentTarget;
    const seekTo = calculateNewTime(event, seekBar);

    if (Math.abs(seekTo - currentTime) > 0.1) {
      applyTimeToVideos(seekTo);
    }
  };

  const handleTimelineLeave = () => {
    if (!isLargeScreen) return;

    setShowPreview(false);
    lastUpdateTimeRef.current = 0;
  };

  const handleMuteClick = () => {
    if (videoRef.current) {
      const newMutedState = !videoRef.current.muted;
      videoRef.current.muted = newMutedState;
      setUserMuted(newMutedState);
    }
  };

  const handleFullscreenClick = () => {
    const player = document.getElementById("video-player");
    const video = videoRef.current;

    if (!video) return;

    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isAndroid = /Android/.test(navigator.userAgent);

    if (isIOS || isAndroid) {
      if (video.requestFullscreen) {
        video
          .requestFullscreen()
          .catch((err) =>
            console.error(
              `Error attempting to enable full-screen mode on mobile: ${err.message} (${err.name})`
            )
          );
      } else if ("webkitEnterFullscreen" in video) {
        (video as any).webkitEnterFullscreen();
      } else if ("mozRequestFullScreen" in video) {
        (video as any).mozRequestFullScreen();
      } else if ("msRequestFullscreen" in video) {
        (video as any).msRequestFullscreen();
      }
    } else {
      if (!document.fullscreenElement) {
        if (player && player.requestFullscreen) {
          player
            .requestFullscreen()
            .catch((err) =>
              console.error(
                `Error attempting to enable full-screen mode: ${err.message} (${err.name})`
              )
            );
        } else if (player && "webkitRequestFullscreen" in player) {
          (player as any).webkitRequestFullscreen();
        } else if (player && "mozRequestFullScreen" in player) {
          (player as any).mozRequestFullScreen();
        } else if (player && "msRequestFullscreen" in player) {
          (player as any).msRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if ("webkitExitFullscreen" in document) {
          (document as any).webkitExitFullscreen();
        } else if ("mozCancelFullScreen" in document) {
          (document as any).mozCancelFullScreen();
        } else if ("msExitFullscreen" in document) {
          (document as any).msExitFullscreen();
        }
      }
    }
  };

  const handleSpeedChange = () => {
    let newSpeed;
    if (videoSpeed === 1) {
      newSpeed = 1.5;
    } else if (videoSpeed === 1.5) {
      newSpeed = 2;
    } else {
      newSpeed = 1;
    }
    setVideoSpeed(newSpeed);
    if (videoRef.current) {
      videoRef.current.playbackRate = newSpeed;
    }
  };

  const watchedPercentage =
    longestDuration > 0 ? (currentTime / longestDuration) * 100 : 0;

  useEffect(() => {
    if (!videoRef.current || !videoReadyToPlay) return;

    const videoElement = videoRef.current;

    if (isPlaying) {
      const playPromise = videoElement.play();
      if (playPromise !== undefined) {
        playPromise.catch((error) => {
          console.error("Error in useEffect play:", error);
        });
      }
    } else {
      videoElement.pause();
    }
  }, [isPlaying, videoReadyToPlay]);

  const parseSubTime = (timeString: number) => {
    const timeStr = timeString.toString();
    const timeParts = timeStr.split(":");

    const hoursValue = timeParts.length > 2 ? Number(timeParts[0]) || 0 : 0;
    const minutesValue =
      timeParts.length > 1 ? Number(timeParts[timeParts.length - 2]) || 0 : 0;
    const secondsValue = Number(timeParts[timeParts.length - 1]) || 0;

    return hoursValue * 3600 + minutesValue * 60 + secondsValue;
  };

  const publicEnv = usePublicEnv();
  const apiClient = useApiClient();

  const { data: transcriptContent, error: transcriptError } = useTranscript(
    data.id,
    data.transcriptionStatus
  );

  // Use custom hook for transcription processing
  const { isTranscriptionProcessing, subtitles } = useTranscriptionProcessing(
    data,
    transcriptContent,
    transcriptError
  );

  const currentSubtitle = subtitles.find(
    (subtitle) =>
      parseSubTime(subtitle.startTime) <= currentTime &&
      parseSubTime(subtitle.endTime) >= currentTime
  );

  useEffect(() => {
    if (previewCanvasRef.current && isLargeScreen) {
      const canvas = previewCanvasRef.current;
      const ctx = canvas.getContext("2d");

      if (ctx) {
        canvas.width = previewWidth;
        canvas.height = previewHeight;

        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = "white";
        ctx.font = "12px Arial";
        ctx.textAlign = "center";
        ctx.fillText("Hover to preview", canvas.width / 2, canvas.height / 2);
      }
    }
  }, [previewCanvasRef, previewWidth, previewHeight, isLargeScreen]);

  useEffect(() => {
    const detectSafari = () => {
      const isSafari =
        /^((?!chrome|android).)*safari/i.test(navigator.userAgent) ||
        (navigator.userAgent.includes("AppleWebKit") &&
          !navigator.userAgent.includes("Chrome"));

      const videoContainer = document.getElementById("video-container");
      if (videoContainer && isSafari) {
        videoContainer.style.height = "calc(100% - 1.75rem)";
      }
    };

    detectSafari();
  }, []);

  if (data.jobStatus === "ERROR") {
    return (
      <div className="flex overflow-hidden justify-center items-center w-full h-full rounded-lg">
        <div
          style={{ paddingBottom: "min(806px, 56.25%)" }}
          className="flex relative justify-center items-center p-8 w-full h-full bg-black rounded-lg"
        >
          <p className="text-xl text-white">
            There was an error when processing the video. Please contact
            support.
          </p>
        </div>
      </div>
    );
  }

  let videoSrc: string;

  if (data.source.type === "desktopMP4") {
    videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=mp4`;
  } else if (
    NODE_ENV === "development" ||
    ((data.skipProcessing === true || data.jobStatus !== "COMPLETE") &&
      data.source.type === "MediaConvert")
  ) {
    videoSrc = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=master`;
  } else if (data.source.type === "MediaConvert") {
    videoSrc = `${publicEnv.s3BucketUrl}/${data.ownerId}/${data.id}/output/video_recording_000.m3u8`;
  } else {
    videoSrc = `${publicEnv.s3BucketUrl}/${data.ownerId}/${data.id}/combined-source/stream.m3u8`;
  }

  return (
    <div
      id="video-container"
      className="overflow-hidden relative w-full h-full rounded-lg shadow-lg group"
    >
      <div
        className={`absolute inset-0 flex items-center justify-center z-10 bg-black transition-opacity duration-300 ${
          isLoading ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <LogoSpinner className="w-8 h-auto animate-spin sm:w-10" />
      </div>
      <div className="relative w-full h-full">
        <div className="absolute inset-0 bg-black">
          {data.source.type === "desktopMP4" ? (
            <MP4VideoPlayer ref={videoRef} videoSrc={videoSrc} />
          ) : (
            <VideoPlayer ref={videoRef} videoSrc={videoSrc} />
          )}
        </div>
        {!isLoading && (
          <div
            className={`absolute inset-0 z-20 flex items-center justify-center transition-opacity duration-300 ${
              (overlayVisible && isPlaying) || tempOverlayVisible || !isPlaying
                ? "opacity-100"
                : "opacity-0"
            }`}
          >
            <button
              aria-label={isPlaying ? "Pause video" : "Play video"}
              className="flex justify-center items-center w-full h-full"
              onClick={() => {
                if (!videoReadyToPlay) {
                  setIsPlaying(true);
                } else {
                  handlePlayPauseClick();
                }
              }}
            >
              <AnimatePresence initial={false} mode="popLayout">
                {isPlaying ? (
                  <motion.div
                    key="pause-button"
                    className="flex relative z-30 justify-center items-center size-20 bg-black bg-opacity-60 rounded-full"
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{
                      scale: 1,
                      opacity: overlayVisible || tempOverlayVisible ? 1 : 0,
                    }}
                    style={{ transformOrigin: "center center" }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                  >
                    <Pause className="w-auto h-8 text-white sm:h-10 md:h-12" />
                  </motion.div>
                ) : (
                  <motion.div
                    key="play-button"
                    className="flex relative z-30 justify-center items-center size-20 bg-black bg-opacity-60 rounded-full"
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{
                      scale: 1,
                      opacity: 1,
                    }}
                    style={{ transformOrigin: "center center" }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                  >
                    <Play className="w-auto h-8 text-white sm:h-10 md:h-12 ml-0.5" />
                  </motion.div>
                )}
              </AnimatePresence>
            </button>
          </div>
        )}
        {currentSubtitle && currentSubtitle.text && subtitlesVisible && (
          <div
            className={`absolute z-10 p-2 w-full text-center transition-all duration-300 ease-in-out ${
              overlayVisible ? "bottom-16 sm:bottom-20" : "bottom-6 sm:bottom-8"
            }`}
          >
            <div className="inline px-2 py-1 text-sm text-white bg-black bg-opacity-75 rounded-xl sm:text-lg md:text-2xl">
              {currentSubtitle.text
                .replace("- ", "")
                .replace(".", "")
                .replace(",", "")}
            </div>
          </div>
        )}
      </div>

      {showPreview && !isLoading && isMP4Source && isLargeScreen && (
        <div
          className="hidden absolute z-30 transition-opacity duration-150 xl:block"
          style={{
            left: `${previewPosition}px`,
            bottom: "80px",
            opacity: previewLoaded ? 1 : 0.7,
          }}
        >
          <div className="flex flex-col items-center">
            <div
              style={{ boxShadow: "0 0 100px rgba(0, 0, 0, 0.75)" }}
              className="bg-black rounded-lg border border-gray-600 overflow-hidden"
            >
              <div
                className="bg-black"
                style={{
                  width: `${previewWidth}px`,
                  height: `${previewHeight}px`,
                }}
              >
                {thumbnailUrl ? (
                  <img
                    src={thumbnailUrl}
                    alt={`Preview at ${formatTime(previewTime)}`}
                    className="object-contain w-full h-full bg-black"
                    onError={() => {
                      setThumbnailUrl(null);
                    }}
                  />
                ) : (
                  <canvas
                    ref={previewCanvasRef}
                    className="object-contain w-full h-full bg-black"
                  />
                )}
              </div>
            </div>
            <div className="mt-2 text-center space-y-0.5">
              {chapters.length > 0 && longestDuration > 0 && (
                <div
                  className="text-sm text-white font-medium leading-tight"
                  style={{ textShadow: "0 0 3px rgba(0, 0, 0, 0.7)" }}
                >
                  {(() => {
                    const previewChapter = chapters.find((chapter, index) => {
                      const nextChapter = chapters[index + 1];
                      const chapterStart = chapter.start;
                      const chapterEnd = nextChapter
                        ? nextChapter.start
                        : longestDuration;
                      return (
                        previewTime >= chapterStart && previewTime < chapterEnd
                      );
                    });
                    return previewChapter ? previewChapter.title : "";
                  })()}
                </div>
              )}
              <div
                className="text-sm text-white font-medium"
                style={{ textShadow: "0 0 3px rgba(0, 0, 0, 0.7)" }}
              >
                {formatTimeWithMilliseconds(previewTime)}
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        className={`absolute left-0 right-0 z-30 transition-all duration-300 ease-in-out ${
          overlayVisible ? "bottom-[40px] md:bottom-[60px]" : "bottom-1"
        }`}
      >
        <div
          id="seek"
          className="h-6 cursor-pointer"
          onMouseDown={handleSeekMouseDown}
          onMouseMove={(e) => {
            if (seeking) {
              handleSeekMouseMove(e);
            }
          }}
          onMouseUp={handleSeekMouseUp}
          onMouseLeave={() => {
            setSeeking(false);
          }}
          onTouchStart={handleSeekMouseDown}
          onTouchMove={(e) => {
            if (seeking) {
              handleSeekMouseMove(e);
            }
          }}
          onTouchEnd={(e) => handleSeekMouseUp(e, true)}
        >
          {!isLoading && (
            <Suspense>
              <CommentIndicators
                className="-mt-6 w-full md:-mt-6"
                comments={comments}
              />
            </Suspense>
          )}

          <div
            className="relative w-full h-full"
            onMouseMove={handleTimelineHover}
            onMouseLeave={handleTimelineLeave}
          >
            {chapters.length > 0 && longestDuration > 0 ? (
              <div className="absolute top-2.5 w-full h-1 sm:h-1.5 z-10 flex">
                {chapters.map((chapter, index) => {
                  const nextChapter = chapters[index + 1];
                  const chapterStart = chapter.start;
                  const chapterEnd = nextChapter
                    ? nextChapter.start
                    : longestDuration;
                  const chapterDuration = chapterEnd - chapterStart;
                  const chapterWidth =
                    (chapterDuration / longestDuration) * 100;

                  const chapterProgress = Math.max(
                    0,
                    Math.min((currentTime - chapterStart) / chapterDuration, 1)
                  );

                  const isCurrentChapter =
                    currentTime >= chapterStart && currentTime < chapterEnd;

                  return (
                    <div
                      key={chapter.start}
                      className="relative h-full cursor-pointer group"
                      style={{ width: `${chapterWidth}%` }}
                      onClick={(e) => {
                        e.stopPropagation();
                        applyTimeToVideos(chapter.start);
                      }}
                    >
                      <div
                        className="w-full h-full bg-gray-400 bg-opacity-50 group-hover:bg-opacity-70 transition-colors"
                        style={{
                          boxShadow: "0 0 20px rgba(0,0,0,0.6)",
                          borderRight:
                            index < chapters.length - 1
                              ? "1px solid rgba(255,255,255,0.3)"
                              : "none",
                        }}
                      />
                      {isCurrentChapter && (
                        <div
                          className="absolute top-0 left-0 h-full bg-white transition-all duration-100"
                          style={{ width: `${chapterProgress * 100}%` }}
                        />
                      )}
                      {currentTime > chapterEnd && (
                        <div className="absolute top-0 left-0 w-full h-full bg-white" />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                <div
                  style={{ boxShadow: "0 0 20px rgba(0,0,0,0.6)" }}
                  className="absolute top-2.5 w-full h-1 sm:h-1.5 bg-gray-400 bg-opacity-50 z-10"
                />
                <div
                  className="absolute top-2.5 h-1 sm:h-1.5 bg-white cursor-pointer z-10"
                  style={{ width: `${watchedPercentage}%` }}
                />
              </>
            )}

            <div
              style={{
                boxShadow: "0 0 20px rgba(0,0,0,0.1)",
                left: `${watchedPercentage}%`,
              }}
              className={clsx(
                "drag-button absolute top-2 z-20 -mt-1.5 -ml-2 w-5 h-5 bg-white rounded-full cursor-pointer focus:outline-none border-2 border-gray-5",
                seeking
                  ? "scale-125 transition-transform ring-blue-300 ring-offset-2 ring-2"
                  : ""
              )}
              tabIndex={0}
            />
          </div>
        </div>
      </div>

      <div
        className={`absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 z-20 transition-transform duration-300 ease-in-out ${
          overlayVisible ? "translate-y-0" : "translate-y-full"
        }`}
        onMouseEnter={() => {
          setIsHoveringControls(true);
        }}
        onMouseLeave={() => {
          setIsHoveringControls(false);
        }}
      >
        <div className="flex justify-between items-center px-4 py-2">
          <div className="flex items-center mt-2 space-x-2 sm:space-x-3">
            <span className="inline-flex">
              <button
                aria-label="Play video"
                className="inline-flex justify-center items-center px-1 py-1 text-sm font-medium text-gray-100 rounded-lg border border-transparent transition duration-150 ease-in-out focus:outline-none hover:text-white focus:border-white hover:bg-gray-100 hover:bg-opacity-10 active:bg-gray-100 active:bg-opacity-10 sm:px-2 sm:py-2"
                tabIndex={0}
                type="button"
                onClick={() => handlePlayPauseClick()}
              >
                {isPlaying ? (
                  <Pause className="w-auto h-5 sm:h-6" />
                ) : (
                  <Play className="w-auto h-5 sm:h-6" />
                )}
              </button>
            </span>
            <div className="flex items-center space-x-2">
              <div className="text-xs sm:text-sm text-white font-medium select-none tabular text-clip overflow-hidden whitespace-nowrap">
                {formatTime(currentTime)} - {formatTime(longestDuration)}
              </div>
              {chapters.length > 0 && longestDuration > 0 && (
                <div className="hidden sm:block text-xs sm:text-sm text-gray-200 font-medium select-none text-clip overflow-hidden whitespace-nowrap max-w-[200px]">
                  {(() => {
                    const currentChapter = chapters.find((chapter, index) => {
                      const nextChapter = chapters[index + 1];
                      const chapterStart = chapter.start;
                      const chapterEnd = nextChapter
                        ? nextChapter.start
                        : longestDuration;
                      return (
                        currentTime >= chapterStart && currentTime < chapterEnd
                      );
                    });
                    return currentChapter ? `• ${currentChapter.title}` : "";
                  })()}
                </div>
              )}
            </div>
          </div>
          <div className="flex justify-end space-x-1 sm:space-x-2">
            <div className="flex justify-end items-center space-x-1 sm:space-x-2">
              <span className="inline-flex">
                <button
                  aria-label={`Change video speed to ${videoSpeed}x`}
                  className="inline-flex min-w-[35px] sm:min-w-[45px] items-center text-xs sm:text-sm font-medium transition ease-in-out duration-150 focus:outline-none border text-gray-100 border-transparent hover:text-white focus:border-white hover:bg-gray-100 hover:bg-opacity-10 active:bg-gray-100 active:bg-gray-100 active:bg-opacity-10 px-1 sm:px-2 py-1 sm:py-2 justify-center rounded-lg"
                  tabIndex={0}
                  type="button"
                  onClick={handleSpeedChange}
                >
                  {videoSpeed}x
                </button>
              </span>
              {isTranscriptionProcessing && subtitles.length === 0 && (
                <span className="inline-flex">
                  <button
                    aria-label={isPlaying ? "Pause video" : "Play video"}
                    className="inline-flex justify-center items-center px-1 py-1 text-sm font-medium text-gray-100 rounded-lg border border-transparent transition duration-150 ease-in-out focus:outline-none hover:text-white focus:border-white hover:bg-gray-100 hover:bg-opacity-10 active:bg-gray-100 active:bg-opacity-10 sm:px-2 sm:py-2"
                    tabIndex={0}
                    type="button"
                    onClick={() => {
                      toast.error("Transcription is processing");
                    }}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="w-5 h-5 sm:w-6 sm:h-6"
                      viewBox="0 0 24 24"
                    >
                      <style>
                        {
                          "@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"
                        }
                      </style>
                      <path
                        fill="#FFF"
                        d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
                        opacity={0.25}
                      />
                      <path
                        fill="#FFF"
                        d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
                        style={{
                          transformOrigin: "center",
                          animation: "spinner_AtaB .75s infinite linear",
                        }}
                      />
                    </svg>
                  </button>
                </span>
              )}
              {aiProcessing && (
                <span className="inline-flex">
                  <button
                    aria-label="AI summary is processing"
                    className="inline-flex justify-center items-center px-1 py-1 text-sm font-medium text-gray-100 rounded-lg border border-transparent transition duration-150 ease-in-out focus:outline-none hover:text-white focus:border-white hover:bg-gray-100 hover:bg-opacity-10 active:bg-gray-100 active:bg-opacity-10 sm:px-2 sm:py-2"
                    tabIndex={0}
                    type="button"
                    onClick={() => {
                      toast.info("AI summary is being generated");
                    }}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="w-5 h-5 sm:w-6 sm:h-6"
                      viewBox="0 0 24 24"
                    >
                      <style>
                        {
                          "@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"
                        }
                      </style>
                      <path
                        fill="#FFF"
                        d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
                        opacity={0.25}
                      />
                      <path
                        fill="#FFF"
                        d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
                        style={{
                          transformOrigin: "center",
                          animation: "spinner_AtaB .75s infinite linear",
                        }}
                      />
                    </svg>
                  </button>
                </span>
              )}
              {subtitles.length > 0 && (
                <span className="inline-flex">
                  <button
                    aria-label={
                      subtitlesVisible ? "Hide subtitles" : "Show subtitles"
                    }
                    className="inline-flex justify-center items-center px-1 py-1 text-sm font-medium text-gray-100 rounded-lg border border-transparent transition duration-150 ease-in-out focus:outline-none hover:text-white focus:border-white hover:bg-gray-100 hover:bg-opacity-10 active:bg-gray-100 active:bg-opacity-10 sm:px-2 sm:py-2"
                    tabIndex={0}
                    type="button"
                    onClick={() => setSubtitlesVisible(!subtitlesVisible)}
                  >
                    {subtitlesVisible ? (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        className="w-auto h-5 sm:h-6"
                        viewBox="0 0 24 24"
                      >
                        <rect
                          width="18"
                          height="14"
                          x="3"
                          y="5"
                          rx="2"
                          ry="2"
                        ></rect>
                        <path d="M7 15h4m4 0h2m4 0h2"></path>
                      </svg>
                    ) : (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        className="w-auto h-5 sm:h-6"
                        viewBox="0 0 24 24"
                      >
                        <path d="M10.5 5H19a2 2 0 012 2v8.5M17 11h-.5M19 19H5a2 2 0 01-2-2V7a2 2 0 012-2M2 2l20 20M7 11h4M7 15h2.5"></path>
                      </svg>
                    )}
                  </button>
                </span>
              )}
              <span className="inline-flex">
                <button
                  aria-label={videoRef?.current?.muted ? "Unmute" : "Mute"}
                  className="inline-flex justify-center items-center px-1 py-1 text-sm font-medium text-gray-100 rounded-lg border border-transparent transition duration-150 ease-in-out focus:outline-none hover:text-white focus:border-white hover:bg-gray-100 hover:bg-opacity-10 active:bg-gray-100 active:bg-opacity-10 sm:px-2 sm:py-2"
                  tabIndex={0}
                  type="button"
                  onClick={() => handleMuteClick()}
                >
                  {videoRef?.current?.muted ? (
                    <VolumeX className="w-auto h-5 sm:h-6" />
                  ) : (
                    <Volume2 className="w-auto h-5 sm:h-6" />
                  )}
                </button>
              </span>
              <span className="inline-flex">
                <button
                  aria-label="Go fullscreen"
                  className="inline-flex justify-center items-center px-1 py-1 text-sm font-medium text-gray-100 rounded-lg border border-transparent transition duration-150 ease-in-out focus:outline-none hover:text-white focus:border-white hover:bg-gray-100 hover:bg-opacity-10 active:bg-gray-100 active:bg-opacity-10 sm:px-2 sm:py-2"
                  tabIndex={0}
                  type="button"
                  onClick={handleFullscreenClick}
                >
                  <Maximize className="w-auto h-5 sm:h-6" />
                </button>
              </span>
            </div>
          </div>
        </div>
      </div>
      {user &&
        !isUserOnProPlan({
          subscriptionStatus: user.stripeSubscriptionStatus,
        }) && (
          <div className="absolute top-4 left-4 z-30">
            <div
              className="block cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setUpgradeModalOpen(true);
              }}
            >
              <div className="relative">
                <div className="opacity-50 transition-opacity hover:opacity-100 peer">
                  <Logo className="w-auto h-4 sm:h-8" white={true} />
                </div>

                <div className="absolute left-0 top-8 transition-transform duration-300 ease-in-out origin-top scale-y-0 peer-hover:scale-y-100">
                  <p className="text-white text-xs font-medium whitespace-nowrap bg-black bg-opacity-50 px-2 py-0.5 rounded">
                    Remove watermark
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      <UpgradeModal
        open={upgradeModalOpen}
        onOpenChange={setUpgradeModalOpen}
      />
    </div>
  );
});

// Custom hook for video source validation using TanStack Query
const useVideoSourceValidation = (
  data: typeof videos.$inferSelect,
  videoMetadataLoaded: boolean
) => {
  return useQuery({
    queryKey: ["video-source-validation", data.id, data.source.type],
    queryFn: async () => {
      if (data.source.type !== "desktopMP4") {
        return { isMP4Source: false };
      }

      const thumbUrl = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&thumbnailTime=0`;

      try {
        const response = await fetch(thumbUrl, { method: "HEAD" });
        return { isMP4Source: response.ok };
      } catch (error) {
        console.error("Error checking thumbnails:", error);
        return { isMP4Source: false };
      }
    },
    enabled: videoMetadataLoaded && data.source.type === "desktopMP4",
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

// Custom hook for screen size detection
const useScreenSize = () => {
  const [isLargeScreen, setIsLargeScreen] = useState(false);

  useEffect(() => {
    const checkScreenSize = () => {
      setIsLargeScreen(window.innerWidth >= 1024);
    };

    checkScreenSize();
    window.addEventListener("resize", checkScreenSize);

    return () => window.removeEventListener("resize", checkScreenSize);
  }, []);

  return isLargeScreen;
};

// Custom hook for transcription processing
const useTranscriptionProcessing = (
  data: typeof videos.$inferSelect,
  transcriptContent: string | undefined,
  transcriptError: any
) => {
  const [isTranscriptionProcessing, setIsTranscriptionProcessing] = useState(
    data.transcriptionStatus === "PROCESSING"
  );
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);

  useEffect(() => {
    if (transcriptContent) {
      const parsedSubtitles = fromVtt(transcriptContent);
      setSubtitles(parsedSubtitles);
      setIsTranscriptionProcessing(false);
    } else if (transcriptError) {
      console.error(
        "[ShareVideo] Subtitle error from React Query:",
        transcriptError.message
      );
      if (transcriptError.message === "TRANSCRIPT_NOT_READY") {
        setIsTranscriptionProcessing(true);
      } else {
        setIsTranscriptionProcessing(false);
      }
    } else if (data.transcriptionStatus === "PROCESSING") {
      setIsTranscriptionProcessing(true);
    } else if (data.transcriptionStatus === "ERROR") {
      setIsTranscriptionProcessing(false);
    }
  }, [transcriptContent, transcriptError, data.transcriptionStatus]);

  return { isTranscriptionProcessing, subtitles };
};

function CommentIndicators(props: {
  className?: string;
  comments: MaybePromise<CommentWithAuthor[]>;
}) {
  const comments = use(props.comments);

  return (
    <div className={props.className}>
      {comments.map((comment) => {
        const commentPosition =
          comment.timestamp === null
            ? 0
            : (comment.timestamp / longestDuration) * 100;

        let tooltipContent = "";
        if (comment.type === "text") {
          tooltipContent =
            comment.authorId === "anonymous"
              ? `Anonymous: ${comment.content}`
              : `${comment.authorName || "User"}: ${comment.content}`;
        } else {
          tooltipContent =
            comment.authorId === "anonymous"
              ? "Anonymous"
              : comment.authorName || "User";
        }

        return (
          <div
            key={comment.id}
            className="absolute z-10 text-sm transition-all hover:scale-125 -mt-5 md:-mt-5"
            style={{
              left: `${commentPosition}%`,
            }}
            data-tooltip-id={comment.id}
            data-tooltip-content={tooltipContent}
          >
            <span>
              {comment.type === "text" ? (
                <MessageSquare
                  fill="#646464"
                  className="w-auto h-[18px] sm:h-[22px] text-white"
                />
              ) : (
                comment.content
              )}
            </span>
            <Tooltip id={comment.id} />
          </div>
        );
      })}
    </div>
  );
}

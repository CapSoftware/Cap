import { apiClient } from "@/utils/web-api";
import { userSelectProps } from "@cap/database/auth/session";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { clientEnv, NODE_ENV } from "@cap/env";
import { Logo, LogoSpinner } from "@cap/ui";
import { isUserOnProPlan, S3_BUCKET_URL } from "@cap/utils";
import clsx from "clsx";
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
} from "react";
import toast from "react-hot-toast";
import { Tooltip } from "react-tooltip";
import { fromVtt, Subtitle } from "subtitles-parser-vtt";
import { MP4VideoPlayer } from "./MP4VideoPlayer";
import { VideoPlayer } from "./VideoPlayer";

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

// million-ignore
// Add this type definition at the top of the file
type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
  authorName: string | null;
};

// Update the component props type
export const ShareVideo = forwardRef<
  HTMLVideoElement,
  {
    data: typeof videos.$inferSelect;
    user: typeof userSelectProps | null;
    comments: CommentWithAuthor[];
  }
>(({ data, user, comments }, ref) => {
  // Forward the ref to the video element
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
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [subtitlesVisible, setSubtitlesVisible] = useState(true);
  const [isTranscriptionProcessing, setIsTranscriptionProcessing] =
    useState(false);

  // Scrubbing preview states
  const [showPreview, setShowPreview] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewPosition, setPreviewPosition] = useState(0);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(160);
  const [previewHeight, setPreviewHeight] = useState(90);
  // Track if we're actually showing MP4 content that supports thumbnails
  const [isMP4Source, setIsMP4Source] = useState(false);
  // Store the current preview image URL
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  const [videoSpeed, setVideoSpeed] = useState(1);
  const overlayTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const hideControlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [forceHideControls, setForceHideControls] = useState(false);
  const [isHoveringControls, setIsHoveringControls] = useState(false);
  const enterControlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Add to the state variables section
  const [scrubbingVideo, setScrubbingVideo] = useState<HTMLVideoElement | null>(
    null
  );

  // Simplify state variables and refs - remove the throttling mechanism that's causing issues
  const [isPreviewSeeking, setIsPreviewSeeking] = useState(false);
  const lastUpdateTimeRef = useRef<number>(0);
  const lastMousePosRef = useRef<number>(0);

  // Add a state to track if we're on a large screen
  const [isLargeScreen, setIsLargeScreen] = useState(false);

  useEffect(() => {
    if (videoRef.current) {
      if (typeof ref === "function") {
        ref(videoRef.current);
      } else if (ref) {
        ref.current = videoRef.current;
      }
    }
  }, [ref]);

  // Initialize thumbnail preview capability
  useEffect(() => {
    if (!videoMetadataLoaded) return;

    // Only enable preview for desktopMP4 sources
    setIsMP4Source(data.source.type === "desktopMP4");

    // Pre-fetch the first thumbnail to check if it exists
    if (data.source.type === "desktopMP4") {
      const thumbUrl = `${clientEnv.NEXT_PUBLIC_WEB_URL}/api/playlist?userId=${data.ownerId}&videoId=${data.id}&thumbnailTime=0`;

      // Check if the thumbnail exists
      fetch(thumbUrl, { method: "HEAD" })
        .then((response) => {
          if (response.ok) {
            console.log("Thumbnails available for this video");
            setIsMP4Source(true);
          } else {
            console.log("No thumbnails available for this video");
            setIsMP4Source(false);
          }
        })
        .catch((error) => {
          console.error("Error checking thumbnails:", error);
          setIsMP4Source(false);
        });
    }
  }, [videoMetadataLoaded, data.ownerId, data.id, data.source.type]);

  const showControls = () => {
    setOverlayVisible(true);
    setIsHovering(true);
    setForceHideControls(false);
    if (hideControlsTimeoutRef.current) {
      clearTimeout(hideControlsTimeoutRef.current);
    }
  };

  const hideControls = () => {
    if (!isHoveringControls) {
      hideControlsTimeoutRef.current = setTimeout(() => {
        setOverlayVisible(false);
        setIsHovering(false);
        setForceHideControls(true);
      }, 250);
    }
  };

  useEffect(() => {
    const handleMouseMove = () => {
      if (forceHideControls) {
        setForceHideControls(false);
      }
      showControls();
      if (!isHoveringControls) {
        hideControls();
      }
    };

    const handleMouseLeave = () => {
      setIsHovering(false);
      setIsHoveringControls(false);
      hideControls();
    };

    const videoContainer = document.getElementById("video-container");
    if (videoContainer) {
      videoContainer.addEventListener("mousemove", handleMouseMove);
      videoContainer.addEventListener("mouseleave", handleMouseLeave);
    }

    return () => {
      if (videoContainer) {
        videoContainer.removeEventListener("mousemove", handleMouseMove);
        videoContainer.removeEventListener("mouseleave", handleMouseLeave);
      }
      if (hideControlsTimeoutRef.current) {
        clearTimeout(hideControlsTimeoutRef.current);
      }
      if (enterControlsTimeoutRef.current) {
        clearTimeout(enterControlsTimeoutRef.current);
      }
    };
  }, [forceHideControls, isHoveringControls]);

  useEffect(() => {
    if (isPlaying) {
      hideControls();
    } else {
      showControls();
    }
  }, [isPlaying]);

  useEffect(() => {
    if (videoMetadataLoaded) {
      // Don't immediately set isLoading to false when metadata loads
      // We'll wait for canplay event to ensure video is ready
    }
  }, [videoMetadataLoaded]);

  useEffect(() => {
    const onVideoLoadedMetadata = () => {
      if (videoRef.current) {
        setLongestDuration(videoRef.current.duration);
        setVideoMetadataLoaded(true);
        // Don't set isLoading to false here
      }
    };

    const onCanPlay = () => {
      setVideoMetadataLoaded(true);
      setVideoReadyToPlay(true);

      // If the video is already playing (user clicked play before it was ready),
      // ensure it actually starts playing now
      if (isPlaying && videoRef.current) {
        // Store the current position before playing
        const currentPosition = videoRef.current.currentTime;

        videoRef.current.play().catch((error) => {
          console.error("Error playing video in onCanPlay:", error);
        });

        // If the video was reset to the beginning, restore the position
        if (videoRef.current.currentTime === 0 && currentPosition > 0) {
          videoRef.current.currentTime = currentPosition;
        }
      }

      // Set a small delay before removing the loading state to ensure smooth transition
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
        // Make sure video is ready to play
        if (!videoReadyToPlay) {
          // If video is not ready yet, wait for it
          console.log("Video not ready to play yet, waiting...");
          // Show the controls to indicate we received the click
          showControls();
          // We'll attempt to play once the video is ready in the onCanPlay handler
          setIsPlaying(true);
        } else {
          // Ensure video is not muted before playing
          videoElement.muted = false;

          // Store the current position before playing
          const currentPosition = videoElement.currentTime;

          // Use a promise to ensure play() completes
          const playPromise = videoElement.play();

          if (playPromise !== undefined) {
            playPromise
              .then(() => {
                setIsPlaying(true);
                console.log("Video playback started successfully");

                // If the video was reset to the beginning, restore the position
                if (videoElement.currentTime === 0 && currentPosition > 0) {
                  videoElement.currentTime = currentPosition;
                }
              })
              .catch((error) => {
                console.error("Error with playing:", error);

                // If autoplay is prevented by browser policy, try again with muted
                if (error.name === "NotAllowedError") {
                  console.log("Autoplay prevented, trying with muted...");
                  videoElement.muted = true;
                  videoElement
                    .play()
                    .then(() => {
                      setIsPlaying(true);
                      // After successful play, unmute if possible
                      setTimeout(() => {
                        videoElement.muted = false;
                      }, 100);

                      // If the video was reset to the beginning, restore the position
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
            // For older browsers that don't return a promise
            setIsPlaying(true);

            // If the video was reset to the beginning, restore the position
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
    // Validate time to ensure it's a finite number
    if (!Number.isFinite(time)) {
      console.warn("Attempted to set non-finite time:", time);
      return;
    }
    // Clamp time between 0 and video duration
    const validTime = Math.max(0, Math.min(time, longestDuration));
    if (videoRef.current) videoRef.current.currentTime = validTime;
    setCurrentTime(validTime);
  };

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !videoReadyToPlay) return;

    // Set up the time update handler only once
    const handleTimeUpdate = () => {
      setCurrentTime(videoElement.currentTime);
    };

    // Add the event listener
    videoElement.addEventListener("timeupdate", handleTimeUpdate);

    // Clean up
    return () => {
      videoElement.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [videoReadyToPlay]); // Only re-run when video becomes ready

  // Separate effect for handling play state changes
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !videoReadyToPlay) return;

    if (isPlaying) {
      // Don't reset the currentTime when playing
      const currentPosition = videoElement.currentTime;

      videoElement.play().catch((error) => {
        console.error("Error playing video", error);
        setIsPlaying(false);
      });

      // If the video was reset to the beginning, restore the position
      if (videoElement.currentTime === 0 && currentPosition > 0) {
        videoElement.currentTime = currentPosition;
      }
    } else {
      videoElement.pause();
    }
  }, [isPlaying, videoReadyToPlay]);

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

  // Set up a hidden video element for scrubbing previews
  useEffect(() => {
    // Only set up scrubbing video on large screens
    if (isMP4Source && data && isLargeScreen) {
      console.log("Setting up scrubbing video");
      const scrubVideo = document.createElement("video");

      // Use the same MP4 source construction as the main video
      const mp4Source = `${clientEnv.NEXT_PUBLIC_WEB_URL}/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=mp4`;

      scrubVideo.src = mp4Source;
      scrubVideo.crossOrigin = "anonymous";
      scrubVideo.preload = "auto";
      scrubVideo.muted = true;
      scrubVideo.style.display = "none";

      // Add event listener for when metadata is loaded
      scrubVideo.addEventListener("loadedmetadata", () => {
        console.log("Scrubbing video metadata loaded");
        // Preload the first frame to ensure we have something to show on first hover
        scrubVideo.currentTime = 0;
      });

      // Wait for the video to be ready to use
      scrubVideo.addEventListener("canplay", () => {
        console.log("Scrubbing video ready for preview");
        setScrubbingVideo(scrubVideo);

        // Preload the first frame after the video is ready
        if (previewCanvasRef.current) {
          const canvas = previewCanvasRef.current;
          const ctx = canvas.getContext("2d");

          if (ctx) {
            // Set canvas dimensions
            if (
              canvas.width !== previewWidth ||
              canvas.height !== previewHeight
            ) {
              canvas.width = previewWidth;
              canvas.height = previewHeight;
            }

            // Draw the initial frame (at time 0)
            try {
              ctx.drawImage(scrubVideo, 0, 0, canvas.width, canvas.height);
              setPreviewLoaded(true);
              console.log("Preloaded initial frame for preview");
            } catch (err) {
              console.error("Error preloading initial frame:", err);
            }
          }
        }
      });

      // Handle errors
      scrubVideo.addEventListener("error", (e) => {
        console.error("Error loading scrubbing video:", e);
      });

      // Append to document body (invisible)
      document.body.appendChild(scrubVideo);

      // Clean up on component unmount
      return () => {
        scrubVideo.remove();
        setScrubbingVideo(null);
      };
    } else if (!isLargeScreen) {
      // Clean up any existing scrubbing video on small screens
      setScrubbingVideo(null);
    }
  }, [isMP4Source, data, previewWidth, previewHeight, isLargeScreen]);

  // Function to update the preview thumbnail
  const updatePreviewFrame = (time: number) => {
    // Skip preview operations on small screens
    if (!isLargeScreen) return;

    if (!isMP4Source) return;

    console.log("Updating preview frame to time:", time);
    setPreviewTime(time);

    // Don't attempt to seek again if already seeking to a position
    if (isPreviewSeeking) {
      console.log("Already seeking, skipping update");
      return;
    }

    // Try to capture frames from the scrubbing video
    try {
      if (scrubbingVideo && previewCanvasRef.current) {
        const canvas = previewCanvasRef.current;
        const ctx = canvas.getContext("2d");

        if (ctx) {
          // Set canvas dimensions only if they haven't been set yet
          if (
            canvas.width !== previewWidth ||
            canvas.height !== previewHeight
          ) {
            canvas.width = previewWidth;
            canvas.height = previewHeight;
          }

          // Set a flag that we're seeking to avoid multiple seeks
          setIsPreviewSeeking(true);

          // Seek to the specific time
          scrubbingVideo.currentTime = time;

          // Listen for the seeked event
          const handleSeeked = (e: Event) => {
            try {
              // Draw the current frame onto the canvas
              ctx.drawImage(scrubbingVideo, 0, 0, canvas.width, canvas.height);

              // Add timestamp overlay
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
              console.log(`Drew frame at time ${time}`);
            } catch (err) {
              console.error("Error drawing frame:", err);
              setIsPreviewSeeking(false);
            }

            // Remove the event listener after use
            scrubbingVideo.removeEventListener("seeked", handleSeeked);
          };

          // Add the seeked event listener
          scrubbingVideo.addEventListener("seeked", handleSeeked);

          // Set a timeout to ensure we don't get stuck waiting for the seeked event
          const timeoutId = setTimeout(() => {
            if (isPreviewSeeking) {
              try {
                // If we're still seeking after 250ms, draw the frame anyway
                ctx.drawImage(
                  scrubbingVideo,
                  0,
                  0,
                  canvas.width,
                  canvas.height
                );

                // Add timestamp overlay
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
                console.log(`Drew frame at time ${time} after timeout`);
              } catch (err) {
                console.error("Error drawing frame after timeout:", err);
              } finally {
                // Always reset the seeking state after timeout
                setIsPreviewSeeking(false);
                scrubbingVideo.removeEventListener("seeked", handleSeeked);
              }
            }
          }, 250);

          // Clean up the timeout if the component unmounts
          return () => clearTimeout(timeoutId);
        }
      } else if (videoRef.current && previewCanvasRef.current) {
        // Fallback to main video if scrubbing video isn't ready
        const canvas = previewCanvasRef.current;
        const video = videoRef.current;
        const ctx = canvas.getContext("2d");

        if (ctx) {
          try {
            // Set canvas dimensions
            canvas.width = previewWidth;
            canvas.height = previewHeight;

            // Draw the current frame from the main video
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            // Add timestamp overlay
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

  // Handle hovering over the timeline
  const handleTimelineHover = (
    event: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>
  ) => {
    if (isLoading) return;

    // Skip preview operations on small screens
    if (!isLargeScreen) return;

    const seekBar = event.currentTarget;
    const time = calculateNewTime(event, seekBar);

    // Set the preview position based on mouse/touch position
    const rect = seekBar.getBoundingClientRect();

    // Get clientX from either mouse or touch event
    let clientX = 0;
    if ("touches" in event && event.touches && event.touches[0]) {
      clientX = event.touches[0].clientX;
    } else if ("clientX" in event) {
      clientX = event.clientX;
    }

    const previewPos = clientX - rect.left - previewWidth / 2;

    // Ensure preview stays within bounds of the video player
    const maxLeft = rect.width - previewWidth;
    const boundedPos = Math.max(0, Math.min(previewPos, maxLeft));

    setPreviewPosition(boundedPos);

    // Always show the preview when hovering
    if (!showPreview) {
      setShowPreview(true);
      // Force an update on the first hover
      updatePreviewFrame(time);
      lastUpdateTimeRef.current = Date.now();
      return;
    }

    // Store the current mouse position
    const currentMousePos = clientX;
    const lastMousePos = lastMousePosRef.current;
    lastMousePosRef.current = currentMousePos;

    // Only update the frame if:
    // 1. It's been more than 500ms since the last update
    // 2. The mouse has moved significantly (more than 10px) since the last update
    // 3. We're not currently in the middle of seeking
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
    const rect = seekBar.getBoundingClientRect();

    // Handle both mouse and touch events
    let clientX = 0;
    if (event.touches && event.touches.length > 0) {
      clientX = event.touches[0].clientX;
    } else if (typeof event.clientX === "number") {
      clientX = event.clientX;
    }

    const offsetX = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const relativePosition = offsetX / rect.width;
    const newTime = relativePosition * longestDuration;
    return newTime;
  };

  const handleSeekMouseDown = () => {
    setSeeking(true);
  };

  const handleSeekMouseUp = (event: React.MouseEvent | React.TouchEvent, isTouch = false) => {
    if (!seeking) return;
    setSeeking(false);
    const seekBar = event.currentTarget;
    const seekTo = calculateNewTime(event, seekBar);
    // we don't want to apply time to videos if it's a touch event (mobile)
    // as it's already being handled by handleSeekMouseMove
    if (!isTouch) {
      applyTimeToVideos(seekTo);
    }
    if (isPlaying) {
      videoRef.current?.play();
    }
    setShowPreview(false);
  };

  const handleSeekMouseMove = (event: React.MouseEvent | React.TouchEvent) => {
    if (!seeking) return;

    const seekBar = event.currentTarget;
    const seekTo = calculateNewTime(event, seekBar);
    applyTimeToVideos(seekTo);
  };

  // Clean up any pending timeout when timeline hover ends
  const handleTimelineLeave = () => {
    // Skip preview operations on small screens
    if (!isLargeScreen) return;

    setShowPreview(false);
    // Reset the last update time when leaving the timeline
    // This ensures the preview will update immediately on the next hover
    lastUpdateTimeRef.current = 0;
  };

  const handleMuteClick = () => {
    if (videoRef.current) {
      videoRef.current.muted = videoRef.current.muted ? false : true;
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
      // For mobile devices, use the video element's fullscreen API
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
          // If autoplay is prevented, don't change the isPlaying state
          // as it will be handled by the click handler
        });
      }
    } else {
      videoElement.pause();
    }
  }, [isPlaying, videoReadyToPlay]);

  const parseSubTime = (timeString: number) => {
    // Convert number to string and ensure it's in the format HH:MM:SS
    const timeStr = timeString.toString();
    const timeParts = timeStr.split(":");

    // Map parts to numbers with proper fallbacks
    const hoursValue = timeParts.length > 2 ? Number(timeParts[0]) || 0 : 0;
    const minutesValue =
      timeParts.length > 1 ? Number(timeParts[timeParts.length - 2]) || 0 : 0;
    const secondsValue = Number(timeParts[timeParts.length - 1]) || 0;

    return hoursValue * 3600 + minutesValue * 60 + secondsValue;
  };

  useEffect(() => {
    const fetchSubtitles = async () => {
      let transcriptionUrl;

      if (
        data.bucket &&
        data.awsBucket !== clientEnv.NEXT_PUBLIC_CAP_AWS_BUCKET
      ) {
        // For custom S3 buckets, fetch through the API
        transcriptionUrl = `/api/playlist?userId=${data.ownerId}&videoId=${data.id}&fileType=transcription`;
      } else {
        // For default Cap storage
        transcriptionUrl = `${S3_BUCKET_URL}/${data.ownerId}/${data.id}/transcription.vtt`;
      }

      try {
        const response = await fetch(transcriptionUrl);
        const text = await response.text();
        const parsedSubtitles = fromVtt(text);
        setSubtitles(parsedSubtitles);
      } catch (error) {
        console.error("Error fetching subtitles:", error);
      }
    };

    if (data.transcriptionStatus === "COMPLETE") {
      fetchSubtitles();
    } else {
      const startTime = Date.now();
      const maxDuration = 2 * 60 * 1000;

      const intervalId = setInterval(() => {
        if (Date.now() - startTime > maxDuration) {
          clearInterval(intervalId);
          return;
        }

        apiClient.video
          .getTranscribeStatus({ query: { videoId: data.id } })
          .then((data) => {
            if (data.status !== 200) return;

            const { transcriptionStatus } = data.body;
            if (transcriptionStatus === "PROCESSING") {
              setIsTranscriptionProcessing(true);
            } else if (transcriptionStatus === "COMPLETE") {
              fetchSubtitles();
              clearInterval(intervalId);
            } else if (transcriptionStatus === "ERROR") {
              clearInterval(intervalId);
            }
          });
      }, 1000);

      return () => clearInterval(intervalId);
    }
  }, [data]);

  const currentSubtitle = subtitles.find(
    (subtitle) =>
      parseSubTime(subtitle.startTime) <= currentTime &&
      parseSubTime(subtitle.endTime) >= currentTime
  );

  // Check screen size on mount and when window resizes
  useEffect(() => {
    const checkScreenSize = () => {
      // lg breakpoint in Tailwind is typically 1024px
      setIsLargeScreen(window.innerWidth >= 1024);
    };

    // Check on mount
    checkScreenSize();

    // Add resize listener
    window.addEventListener("resize", checkScreenSize);

    // Clean up
    return () => window.removeEventListener("resize", checkScreenSize);
  }, []);

  // Initialize the preview canvas
  useEffect(() => {
    // Only initialize preview canvas on large screens
    if (previewCanvasRef.current && isLargeScreen) {
      const canvas = previewCanvasRef.current;
      const ctx = canvas.getContext("2d");

      if (ctx) {
        // Set canvas dimensions
        canvas.width = previewWidth;
        canvas.height = previewHeight;

        // Draw a black background initially
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Add a "hover to preview" text
        ctx.fillStyle = "white";
        ctx.font = "12px Arial";
        ctx.textAlign = "center";
        ctx.fillText("Hover to preview", canvas.width / 2, canvas.height / 2);
      }
    }
  }, [previewCanvasRef, previewWidth, previewHeight, isLargeScreen]);

  useEffect(() => {
    // Safari detection for applying specific styles
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
    videoSrc = `${clientEnv.NEXT_PUBLIC_WEB_URL}/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=mp4`;
  } else if (
    // v.cap.so is only available in prod
    NODE_ENV === "development" ||
    ((data.skipProcessing === true || data.jobStatus !== "COMPLETE") &&
      data.source.type === "MediaConvert")
  ) {
    videoSrc = `${clientEnv.NEXT_PUBLIC_WEB_URL}/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=master`;
  } else if (data.source.type === "MediaConvert") {
    videoSrc = `${S3_BUCKET_URL}/${data.ownerId}/${data.id}/output/video_recording_000.m3u8`;
  } else {
    videoSrc = `${S3_BUCKET_URL}/${data.ownerId}/${data.id}/combined-source/stream.m3u8`;
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
            className={`absolute inset-0 z-20 flex items-center justify-center bg-black bg-opacity-50 transition-opacity duration-300 ${
              (overlayVisible || isHovering) && !forceHideControls
                ? "opacity-100"
                : "opacity-0"
            }`}
          >
            <button
              aria-label={isPlaying ? "Pause video" : "Play video"}
              className="flex justify-center items-center w-full h-full"
              onClick={() => {
                if (!videoReadyToPlay) {
                  // If video is not ready, set a visual indicator but don't try to play yet
                  console.log("Video not ready to play yet, waiting...");
                  // Show the controls to indicate we received the click
                  showControls();
                  // We'll attempt to play once the video is ready in the onCanPlay handler
                  setIsPlaying(true);
                } else {
                  // Normal play/pause behavior when video is ready
                  handlePlayPauseClick();
                  showControls();
                  hideControls();
                }
              }}
            >
              {isPlaying ? (
                <Pause className="w-auto h-10 text-white sm:h-12 md:h-14 hover:opacity-50" />
              ) : (
                <Play className="w-auto h-10 text-white sm:h-12 md:h-14 hover:opacity-50" />
              )}
            </button>
          </div>
        )}
        {currentSubtitle && currentSubtitle.text && subtitlesVisible && (
          <div className="absolute bottom-12 z-10 p-2 w-full text-center sm:bottom-16">
            <div className="inline px-2 py-1 text-sm text-white bg-black bg-opacity-75 rounded-xl sm:text-lg md:text-2xl">
              {currentSubtitle.text
                .replace("- ", "")
                .replace(".", "")
                .replace(",", "")}
            </div>
          </div>
        )}
      </div>

      {/* Thumbnail preview - MP4 only, visible only on screens larger than lg */}
      {showPreview && !isLoading && isMP4Source && isLargeScreen && (
        <div
          className="hidden overflow-hidden absolute z-30 bg-black rounded-md border border-gray-700 shadow-lg transition-opacity duration-150 xl:block"
          style={{
            left: `${previewPosition}px`,
            bottom: "70px",
            width: `${previewWidth}px`,
            height: `${previewHeight}px`,
            opacity: previewLoaded ? 1 : 0.7,
          }}
        >
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={`Preview at ${formatTime(previewTime)}`}
              className="object-contain w-full h-full bg-black"
              onError={(e) => {
                console.log(
                  "Thumbnail failed to load, using canvas preview instead"
                );
                setThumbnailUrl(null);
              }}
            />
          ) : (
            <canvas
              ref={previewCanvasRef}
              className="object-contain w-full h-full bg-black"
            />
          )}
          {!thumbnailUrl && (
            <div className="absolute right-0 bottom-0 left-0 px-2 py-1 text-xs text-center text-white bg-black bg-opacity-70">
              {formatTime(previewTime)}
            </div>
          )}
        </div>
      )}

      <div
        className={`absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 z-20 transition-opacity duration-300 ${
          (overlayVisible || isHovering || isHoveringControls) &&
          !forceHideControls
            ? "opacity-100"
            : "opacity-0"
        }`}
        onMouseEnter={() => {
          if (enterControlsTimeoutRef.current) {
            clearTimeout(enterControlsTimeoutRef.current);
          }
          enterControlsTimeoutRef.current = setTimeout(() => {
            setIsHoveringControls(true);
          }, 100);
        }}
        onMouseLeave={() => {
          if (enterControlsTimeoutRef.current) {
            clearTimeout(enterControlsTimeoutRef.current);
          }
          setIsHoveringControls(false);
        }}
      >
        <div
          id="seek"
          className="absolute right-0 left-0 -top-2 mx-2 h-6 cursor-pointer sm:mx-4"
          onMouseDown={handleSeekMouseDown}
          onMouseMove={(e) => {
            if (seeking) {
              handleSeekMouseMove(e);
            } else {
              handleTimelineHover(e);
            }
          }}
          onMouseUp={handleSeekMouseUp}
          onMouseLeave={() => {
            setSeeking(false);
            handleTimelineLeave();
          }}
          onTouchStart={handleSeekMouseDown}
          onTouchMove={(e) => {
            if (seeking) {
              handleSeekMouseMove(e);
            } else {
              handleTimelineHover(e);
            }
          }}
          onTouchEnd={(e) => handleSeekMouseUp(e, true)}
        >
          {!isLoading && comments !== null && (
            <div className="-mt-7 w-full md:-mt-6">
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
                    className="absolute z-10 text-sm transition-all hover:scale-125"
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
          )}
          <div className="absolute top-2.5 w-full h-1 sm:h-1.5 bg-white bg-opacity-50 rounded-full z-10" />
          <div
            className="absolute top-2.5 h-1 sm:h-1.5 bg-white rounded-full cursor-pointer z-10"
            style={{ width: `${watchedPercentage}%` }}
          />
          <div
            className={clsx("drag-button absolute top-2.5 z-20 -mt-1.5 -ml-2 w-4 h-4 bg-white rounded-full  cursor-pointer focus:outline-none", 
              seeking ? "scale-125 transition-transform ring-blue-300 ring-offset-2 ring-2" : ""
            )}
            tabIndex={0}
            style={{ left: `${watchedPercentage}%` }}
          />
        </div>
        <div className="flex justify-between items-center px-4 py-2">
          <div className="flex items-center mt-2 space-x-2 sm:space-x-3">
            <span className="inline-flex">
              <button
                aria-label="Play video"
                className="inline-flex justify-center items-center px-1 py-1 text-sm font-medium rounded-lg border border-transparent transition duration-150 ease-in-out focus:outline-none text-slate-100 hover:text-white focus:border-white hover:bg-slate-100 hover:bg-opacity-10 active:bg-slate-100 active:bg-opacity-10 sm:px-2 sm:py-2"
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
            <div className="text-xs sm:text-sm text-white font-medium select-none tabular text-clip overflow-hidden whitespace-nowrap space-x-0.5">
              {formatTime(currentTime)} - {formatTime(longestDuration)}
            </div>
          </div>
          <div className="flex justify-end space-x-1 sm:space-x-2">
            <div className="flex justify-end items-center space-x-1 sm:space-x-2">
              <span className="inline-flex">
                <button
                  aria-label={`Change video speed to ${videoSpeed}x`}
                  className="inline-flex min-w-[35px] sm:min-w-[45px] items-center text-xs sm:text-sm font-medium transition ease-in-out duration-150 focus:outline-none border text-slate-100 border-transparent hover:text-white focus:border-white hover:bg-slate-100 hover:bg-opacity-10 active:bg-slate-100 active:bg-opacity-10 px-1 sm:px-2 py-1 sm:py-2 justify-center rounded-lg"
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
                    className="inline-flex justify-center items-center px-1 py-1 text-sm font-medium rounded-lg border border-transparent transition duration-150 ease-in-out focus:outline-none text-slate-100 hover:text-white focus:border-white hover:bg-slate-100 hover:bg-opacity-10 active:bg-slate-100 active:bg-opacity-10 sm:px-2 sm:py-2"
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
              {subtitles.length > 0 && (
                <span className="inline-flex">
                  <button
                    aria-label={
                      subtitlesVisible ? "Hide subtitles" : "Show subtitles"
                    }
                    className="inline-flex justify-center items-center px-1 py-1 text-sm font-medium rounded-lg border border-transparent transition duration-150 ease-in-out focus:outline-none text-slate-100 hover:text-white focus:border-white hover:bg-slate-100 hover:bg-opacity-10 active:bg-slate-100 active:bg-opacity-10 sm:px-2 sm:py-2"
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
                  className="inline-flex justify-center items-center px-1 py-1 text-sm font-medium rounded-lg border border-transparent transition duration-150 ease-in-out focus:outline-none text-slate-100 hover:text-white focus:border-white hover:bg-slate-100 hover:bg-opacity-10 active:bg-slate-100 active:bg-opacity-10 sm:px-2 sm:py-2"
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
                  className="inline-flex justify-center items-center px-1 py-1 text-sm font-medium rounded-lg border border-transparent transition duration-150 ease-in-out focus:outline-none text-slate-100 hover:text-white focus:border-white hover:bg-slate-100 hover:bg-opacity-10 active:bg-slate-100 active:bg-opacity-10 sm:px-2 sm:py-2"
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
            <a
              href="/pricing"
              target="_blank"
              className="block cursor-pointer"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="relative">
                <div className="opacity-50 transition-opacity hover:opacity-100 peer">
                  <Logo className="w-auto h-4 sm:h-6" white={true} />
                </div>

                {/* Text only appears when hovering the exact logo element */}
                <div className="absolute left-0 top-6 transition-transform duration-300 ease-in-out origin-top scale-y-0 peer-hover:scale-y-100">
                  <p className="text-white text-xs font-medium whitespace-nowrap bg-black bg-opacity-50 px-2 py-0.5 rounded">
                    Upgrade to Cap Pro and remove the watermark
                  </p>
                </div>
              </div>
            </a>
          </div>
        )}
    </div>
  );
});

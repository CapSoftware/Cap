import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

interface MP4VideoPlayerProps {
  videoSrc: string;
}

// million-ignore
export const MP4VideoPlayer = memo(
  forwardRef<HTMLVideoElement, MP4VideoPlayerProps>(({ videoSrc }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const retryCount = useRef(0);
    const retryTimeout = useRef<NodeJS.Timeout | null>(null);
    const startTime = useRef<number>(Date.now());
    const [isLoaded, setIsLoaded] = useState(false);
    const [currentSrc, setCurrentSrc] = useState(videoSrc);
    const [hasError, setHasError] = useState(false);
    const maxRetries = 3;

    useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

    const fetchNewUrl = useCallback(async () => {
      try {
        const timestamp = new Date().getTime();
        const urlWithTimestamp = videoSrc.includes("?")
          ? `${videoSrc}&_t=${timestamp}`
          : `${videoSrc}?_t=${timestamp}`;

        const response = await fetch(urlWithTimestamp, { method: "HEAD" });

        if (response.redirected) {
          setCurrentSrc(response.url);
          return response.url;
        } else {
          return urlWithTimestamp;
        }
      } catch (error) {
        console.error("Error fetching new video URL:", error);
        const timestamp = new Date().getTime();
        return videoSrc.includes("?")
          ? `${videoSrc}&_t=${timestamp}`
          : `${videoSrc}?_t=${timestamp}`;
      }
    }, [videoSrc]);

    const reloadVideo = useCallback(async () => {
      const video = videoRef.current;
      if (!video || retryCount.current >= maxRetries) return;

      console.log(
        `Reloading video (attempt ${retryCount.current + 1}/${maxRetries})`
      );

      const currentPosition = video.currentTime;
      const wasPlaying = !video.paused;

      const newUrl = await fetchNewUrl();

      const sourceElement = video.querySelector("source");
      if (sourceElement) {
        sourceElement.setAttribute("src", newUrl);
      }

      video.load();

      if (currentPosition > 0) {
        const restorePosition = () => {
          video.currentTime = currentPosition;
          if (wasPlaying) {
            video
              .play()
              .catch((err) => console.error("Error resuming playback:", err));
          }
          video.removeEventListener("canplay", restorePosition);
        };
        video.addEventListener("canplay", restorePosition);
      }

      retryCount.current += 1;
    }, [fetchNewUrl, maxRetries]);

    const setupRetry = useCallback(() => {
      if (retryTimeout.current) {
        clearTimeout(retryTimeout.current);
      }

      if (retryCount.current >= maxRetries) {
        console.error(`Video failed to load after ${maxRetries} attempts`);
        setHasError(true);
        return;
      }

      const elapsedMs = Date.now() - startTime.current;
      if (elapsedMs > 60000) {
        console.error("Video failed to load after 1 minute");
        setHasError(true);
        return;
      }

      let retryInterval: number;
      if (retryCount.current === 0) {
        retryInterval = 2000;
      } else if (retryCount.current === 1) {
        retryInterval = 5000;
      } else {
        retryInterval = 10000;
      }

      retryTimeout.current = setTimeout(() => {
        reloadVideo();
      }, retryInterval);
    }, [reloadVideo, maxRetries]);

    useEffect(() => {
      setCurrentSrc(videoSrc);
      setIsLoaded(false);
      setHasError(false);
      retryCount.current = 0;
      startTime.current = Date.now();

      if (retryTimeout.current) {
        clearTimeout(retryTimeout.current);
        retryTimeout.current = null;
      }
    }, [videoSrc]);

    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;

      const handleLoadedData = () => {
        console.log("Video loaded successfully");
        setIsLoaded(true);
        setHasError(false);
        if (videoRef.current) {
          videoRef.current.dispatchEvent(new Event("canplay"));
        }
        if (retryTimeout.current) {
          clearTimeout(retryTimeout.current);
          retryTimeout.current = null;
        }
      };

      const handleLoadedMetadata = () => {
        if (videoRef.current) {
          videoRef.current.dispatchEvent(new Event("loadedmetadata"));
        }
      };

      const handleError = (e: ErrorEvent) => {
        console.error("Video loading error:", e);
        if (!isLoaded && !hasError) {
          setupRetry();
        }
      };

      const handleCanPlay = () => {
        setIsLoaded(true);
        setHasError(false);
        if (retryTimeout.current) {
          clearTimeout(retryTimeout.current);
          retryTimeout.current = null;
        }
      };

      video.addEventListener("loadeddata", handleLoadedData);
      video.addEventListener("loadedmetadata", handleLoadedMetadata);
      video.addEventListener("error", handleError as EventListener);
      video.addEventListener("canplay", handleCanPlay);

      if (!isLoaded && !hasError && retryCount.current === 0) {
        const initialTimeout = setTimeout(() => {
          if (!isLoaded && !hasError) {
            console.log(
              "Video taking longer than expected to load, attempting reload"
            );
            setupRetry();
          }
        }, 10000);

        return () => {
          clearTimeout(initialTimeout);
          video.removeEventListener("loadeddata", handleLoadedData);
          video.removeEventListener("loadedmetadata", handleLoadedMetadata);
          video.removeEventListener("error", handleError as EventListener);
          video.removeEventListener("canplay", handleCanPlay);
          if (retryTimeout.current) {
            clearTimeout(retryTimeout.current);
          }
        };
      }

      return () => {
        video.removeEventListener("loadeddata", handleLoadedData);
        video.removeEventListener("loadedmetadata", handleLoadedMetadata);
        video.removeEventListener("error", handleError as EventListener);
        video.removeEventListener("canplay", handleCanPlay);
        if (retryTimeout.current) {
          clearTimeout(retryTimeout.current);
        }
      };
    }, [currentSrc, isLoaded, hasError, setupRetry]);

    if (hasError) {
      return (
        <div className="flex justify-center items-center w-full h-full text-white bg-black">
          <p>Unable to load video</p>
        </div>
      );
    }

    return (
      <video
        id="video-player"
        ref={videoRef}
        className="object-contain w-full h-full"
        preload="auto"
        playsInline
        controls={false}
        muted
      >
        <source src={currentSrc} type="video/mp4" />
      </video>
    );
  })
);

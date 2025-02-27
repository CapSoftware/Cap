import {
  memo,
  forwardRef,
  useRef,
  useImperativeHandle,
  useEffect,
  useState,
  useCallback,
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
    const lastAttemptTime = useRef<number>(Date.now());

    useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

    const fetchNewUrl = useCallback(async () => {
      try {
        // Add timestamp to prevent caching
        const timestamp = new Date().getTime();
        const urlWithTimestamp = videoSrc.includes("?")
          ? `${videoSrc}&_t=${timestamp}`
          : `${videoSrc}?_t=${timestamp}`;

        const response = await fetch(urlWithTimestamp, { method: "HEAD" });

        if (response.redirected) {
          // If the API redirected us, use the redirected URL
          setCurrentSrc(response.url);
          return response.url;
        } else {
          // If no redirect (which is unusual for desktopMP4), just use the original URL
          return urlWithTimestamp;
        }
      } catch (error) {
        console.error("Error fetching new video URL:", error);
        // Return the original URL with timestamp if fetch fails
        const timestamp = new Date().getTime();
        return videoSrc.includes("?")
          ? `${videoSrc}&_t=${timestamp}`
          : `${videoSrc}?_t=${timestamp}`;
      }
    }, [videoSrc]);

    const reloadVideo = useCallback(async () => {
      const video = videoRef.current;
      if (!video) return;

      // Get a fresh URL from the API
      const newUrl = await fetchNewUrl();

      // Update the video source
      const sourceElement = video.querySelector("source");
      if (sourceElement) {
        sourceElement.setAttribute("src", newUrl);
      }

      // Reset video and reload with new source
      video.load();

      // Update the last attempt time
      lastAttemptTime.current = Date.now();
    }, [fetchNewUrl]);

    const setupRetry = useCallback(() => {
      // Clear any existing timeout
      if (retryTimeout.current) {
        clearTimeout(retryTimeout.current);
      }

      // If we've been trying for more than 2 minutes, stop retrying
      const elapsedMs = Date.now() - startTime.current;
      if (elapsedMs > 120000) {
        console.error("Video failed to load after 2 minutes of retries");
        return;
      }

      // Progressive retry strategy:
      // - First attempt: immediate retry (10ms delay)
      // - First 1 second: retry every 200ms
      // - First 5 seconds: retry every 300ms
      // - After 5 seconds: retry every 1000ms
      let retryInterval: number;

      if (retryCount.current === 0) {
        retryInterval = 10; // Almost immediate first retry
      } else if (elapsedMs < 1000) {
        retryInterval = 200; // Very aggressive for first second
      } else if (elapsedMs < 5000) {
        retryInterval = 300; // Aggressive for first 5 seconds
      } else {
        retryInterval = 1000; // Every second after that
      }

      retryCount.current += 1;
      retryTimeout.current = setTimeout(() => {
        console.log(
          `Retry attempt ${retryCount.current} for video (interval: ${retryInterval}ms)`
        );
        reloadVideo();
      }, retryInterval);
    }, [reloadVideo]);

    // Reset everything when video source changes
    useEffect(() => {
      setCurrentSrc(videoSrc);
      setIsLoaded(false);
      retryCount.current = 0;
      startTime.current = Date.now();
      lastAttemptTime.current = Date.now();

      // Clear any existing timeout
      if (retryTimeout.current) {
        clearTimeout(retryTimeout.current);
        retryTimeout.current = null;
      }
    }, [videoSrc]);

    // Main video loading and event handling
    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;

      const handleLoadedData = () => {
        console.log("Video loaded successfully");
        setIsLoaded(true);
        // Clear any retry timeouts if video is loaded
        if (retryTimeout.current) {
          clearTimeout(retryTimeout.current);
          retryTimeout.current = null;
        }
      };

      const handleLoadedMetadata = () => {
        // Trigger a canplay event after metadata is loaded
        video.dispatchEvent(new Event("canplay"));
      };

      const handleError = (e: ErrorEvent) => {
        console.error("Video loading error:", e);
        if (!isLoaded) {
          setupRetry();
        }
      };

      const handleStalled = () => {
        console.log("Video stalled, retrying...");
        if (!isLoaded) {
          setupRetry();
        }
      };

      // Add event listeners
      video.addEventListener("loadeddata", handleLoadedData);
      video.addEventListener("loadedmetadata", handleLoadedMetadata);
      video.addEventListener("error", handleError as EventListener);
      video.addEventListener("stalled", handleStalled);

      // Initial load
      reloadVideo();

      // Setup a periodic check for videos that don't trigger error events
      // but aren't loading either - check more frequently
      const loadingCheckInterval = setInterval(() => {
        const now = Date.now();
        const timeSinceLastAttempt = now - lastAttemptTime.current;

        // If it's been more than 2 seconds since our last attempt and video isn't loaded
        if (!isLoaded && timeSinceLastAttempt > 2000) {
          console.log("Video loading timed out, retrying...");
          setupRetry();
        }
      }, 2000);

      return () => {
        // Cleanup event listeners
        video.removeEventListener("loadeddata", handleLoadedData);
        video.removeEventListener("loadedmetadata", handleLoadedMetadata);
        video.removeEventListener("error", handleError as EventListener);
        video.removeEventListener("stalled", handleStalled);

        // Clear intervals and timeouts
        clearInterval(loadingCheckInterval);
        if (retryTimeout.current) {
          clearTimeout(retryTimeout.current);
        }
      };
    }, [currentSrc, isLoaded, reloadVideo, setupRetry]);

    return (
      <video
        id="video-player"
        ref={videoRef}
        className="w-full h-full object-contain"
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

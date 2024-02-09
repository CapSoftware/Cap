// @refresh reset

import React, { useEffect, useRef, useMemo, useState } from "react";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";

export const Camera = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { sharedStream } = useMediaDevices();
  const [isLoading, setIsLoading] = useState(true);

  const attemptPlayback = () => {
    const videoElement = videoRef.current;
    if (videoElement && !videoElement.srcObject) {
      console.log("Assigning stream to video element.");
      videoElement.srcObject = sharedStream;
      setIsLoading(false);
    }

    if (videoElement && videoElement.paused) {
      console.log("Attempting to play video.");
      videoElement
        .play()
        .then(() => {
          console.log("Video playback started successfully.");
        })
        .catch((error) => {
          console.log(`Error attempting to play video: ${error.message}`);
        });
    }
  };

  useEffect(() => {
    if (sharedStream) {
      attemptPlayback();
      const handleTrackAdded = () => attemptPlayback();
      const handleTrackRemoved = () => attemptPlayback();

      sharedStream.addEventListener("addtrack", handleTrackAdded);
      sharedStream.addEventListener("removetrack", handleTrackRemoved);

      return () => {
        sharedStream.removeEventListener("addtrack", handleTrackAdded);
        sharedStream.removeEventListener("removetrack", handleTrackRemoved);
      };
    }
  }, [sharedStream]);

  return (
    <div
      data-tauri-drag-region
      className="w-[250px] h-[250px] bg-gray-200 rounded-full m-0 p-0 relative overflow-hidden flex items-center justify-center"
    >
      {isLoading && (
        <div className="w-full h-full absolute top-0 left-0 bg-gray-200 z-10 flex items-center justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            stroke="#fff"
            viewBox="0 0 38 38"
            className="w-24 h-24"
          >
            <g
              fill="none"
              fillRule="evenodd"
              strokeWidth="2"
              transform="translate(1 1)"
            >
              <circle cx="18" cy="18" r="18" strokeOpacity="0.4"></circle>
              <path d="M36 18c0-9.94-8.06-18-18-18">
                <animateTransform
                  attributeName="transform"
                  dur="1s"
                  from="0 18 18"
                  repeatCount="indefinite"
                  to="360 18 18"
                  type="rotate"
                ></animateTransform>
              </path>
            </g>
          </svg>
        </div>
      )}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
      />
    </div>
  );
};

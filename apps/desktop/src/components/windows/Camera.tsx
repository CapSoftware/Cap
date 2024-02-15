// @refresh reset

import React, { useEffect, useRef, useState } from "react";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";

export const Camera = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { selectedVideoDevice } = useMediaDevices();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!videoRef.current || !selectedVideoDevice) return;
    const video = videoRef.current;
    const constraints = {
      video: {
        deviceId: selectedVideoDevice.deviceId,
      },
    };

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        video.srcObject = stream;
        video.play();
        setIsLoading(false);
      })
      .catch((err) => {
        console.error(err);
      });

    return () => {
      if (video.srcObject) {
        const stream = video.srcObject as MediaStream;
        stream.getTracks().forEach((track) => {
          track.stop();
        });
      }
    };
  }, [selectedVideoDevice]);

  return (
    <div
      data-tauri-drag-region
      className="w-full h-full bg-gray-200 rounded-full m-0 p-0 relative overflow-hidden flex items-center justify-center border-none outline-none focus:outline-none"
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

"use client";

import { useEffect, useRef, useState } from "react";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";

export const Camera = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { selectedVideoDevice } = useMediaDevices();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let activeStream: MediaStream | null = null;

    const setupCamera = async () => {
      if (!videoRef.current || !selectedVideoDevice) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(
          (device) => device.kind === "videoinput"
        );
        const deviceId = videoDevices[selectedVideoDevice.index].deviceId;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: deviceId,
            frameRate: { ideal: 30 },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });

        // Save stream
        activeStream = stream;

        const videoTrack = stream.getVideoTracks()[0];
        const settings = videoTrack.getSettings();
        const videoProperties = {
          framerate: settings.frameRate ? String(settings.frameRate) : "",
          resolution: `${settings.width}x${settings.height}`,
        };
        localStorage.setItem(
          "videoDeviceProperties",
          JSON.stringify(videoProperties)
        );

        const video = videoRef.current;
        video.srcObject = stream;
        video.onplaying = () => {
          setIsLoading(false);
        };
        await video.play();
      } catch (err) {
        console.error(err);
        setIsLoading(false);
      }
    };

    setupCamera();

    // Cleanup function to stop the stream and reset loading state
    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach((track) => track.stop());
        activeStream = null;
      }
      // Avoid loading when the component is not actually loading
      setIsLoading(false);
    };
  }, [selectedVideoDevice, videoRef]);

  return (
    <div
      data-tauri-drag-region
      className="w-[200px] h-[200px] bg-gray-200 rounded-full m-0 p-0 relative overflow-hidden flex items-center justify-center"
    >
      {isLoading ? (
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
      ) : (
        <video
          ref={videoRef}
          autoPlay
          muted
          className="absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
        />
      )}
    </div>
  );
};

"use client";

import React, { use, useEffect, useRef, useState } from "react";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { CloseX } from "@/components/icons/CloseX";
import { Flip } from "@/components/icons/Flip";
import { emit } from "@tauri-apps/api/event";

export const Camera = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { selectedVideoDevice } = useMediaDevices();
  const [isLoading, setIsLoading] = useState(true);
  const tauriWindowImport = import("@tauri-apps/api/window");
  const [cameraMirrored, setCameraMirrored] = useState(
    typeof window !== "undefined"
      ? localStorage.getItem("cameraMirrored") || "false"
      : "false"
  );

  useEffect(() => {
    if (!videoRef.current || !selectedVideoDevice) return;
    const video = videoRef.current;
    const constraints = {
      video: {
        deviceId: selectedVideoDevice.id,
      },
    };

    if (typeof navigator === "undefined") return;

    const initializeVideoStream = () => {
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
    }
    initializeVideoStream();

    const onVisibilityChanged = () => {
      if (!document.hidden) initializeVideoStream();
    }

    const stop = () => {
      if (video.srcObject) {
        const stream = video.srcObject as MediaStream;
        stream.getTracks().forEach((track) => {
          track.stop();
        });
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChanged);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChanged);
    };
  }, [selectedVideoDevice]);

  const mirrorCamera = () => {
    if (videoRef.current) {
      const video = videoRef.current;
      const newCameraMirrored = cameraMirrored === "true" ? "false" : "true";
      video.style.transform =
        newCameraMirrored === "true" ? "scaleX(-1)" : "scaleX(1)";
      setCameraMirrored(newCameraMirrored);
      if (typeof window !== "undefined") {
        localStorage.setItem("cameraMirrored", newCameraMirrored);
      }
    }
  };

  const setWindowSize = async (type: "sm" | "lg") => {
    if (typeof window === "undefined") return;

    tauriWindowImport.then(
      ({ currentMonitor, appWindow, LogicalSize, LogicalPosition }) => {
        currentMonitor().then((monitor) => {
          const windowWidth = type === "sm" ? 230 : 400;
          const windowHeight = type === "sm" ? 230 : 400;

          if (monitor && monitor.size) {
            const scalingFactor = monitor.scaleFactor;
            const x = 100;
            const y = monitor.size.height / scalingFactor - windowHeight - 100;

            console.log(
              scalingFactor,
              x,
              y,
              windowWidth,
              windowHeight,
              monitor
            );

            appWindow.setSize(new LogicalSize(windowWidth, windowHeight));
            appWindow.setPosition(new LogicalPosition(x / scalingFactor, y));
          }
        });
      }
    );
  };

  const closeWindow = (emitSetDevice = true) => {
    if (typeof window === "undefined") return;

    tauriWindowImport.then(async ({ appWindow }) => {
      if (emitSetDevice) {
        await emit("change-device", {
          type: "videoinput",
          device: null,
        });
      }
      appWindow.close();
    });
  };

  useEffect(() => {
    if (videoRef.current) {
      const video = videoRef.current;
      video.style.transform =
        cameraMirrored === "true" ? "scaleX(-1)" : "scaleX(1)";
    }
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="cursor-move group w-full h-full bg-gray-200 rounded-full m-0 p-0 relative overflow-hidden flex items-center justify-center border-none outline-none focus:outline-none rounded-full"
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
      <div className="opacity-0 group-hover:opacity-100 absolute top-3 left-1/2 transform -translate-x-1/2 bg-gray-800 rounded-xl z-20 grid grid-cols-4 overflow-hidden">
        <div
          onClick={() => {
            closeWindow();
          }}
          className="h-full flex items-center justify-center p-2 hover:bg-gray-900"
        >
          <div>
            <CloseX className="w-5 h-5 stroke-gray-200" />
          </div>
        </div>
        <div
          onClick={async () => {
            await setWindowSize("sm");
          }}
          className="h-full flex items-center justify-center p-2 hover:bg-gray-900"
        >
          <span className="w-1 h-1 m-0 p-0 bg-gray-200 rounded-full"></span>
        </div>
        <div
          onClick={async () => {
            await setWindowSize("lg");
          }}
          className="h-full flex items-center justify-center p-2 hover:bg-gray-900"
        >
          <span className="w-3 h-3 bg-gray-200 rounded-full"></span>
        </div>
        <div
          onClick={mirrorCamera}
          className="h-full flex items-center justify-center p-2 hover:bg-gray-900"
        >
          <div>
            <Flip className="w-5 h-5 stroke-gray-200" />
          </div>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
      ></canvas>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute top-0 left-0 w-full h-full object-cover pointer-events-none rounded-full"
      />
    </div>
  );
};

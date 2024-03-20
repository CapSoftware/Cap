import React, { useEffect, useRef, useState } from "react";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { CloseX } from "@/components/icons/CloseX";
import { emit } from "@tauri-apps/api/event";

export const Camera = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { selectedVideoDevice } = useMediaDevices();
  const [isLoading, setIsLoading] = useState(true);
  const tauriWindowImport = import("@tauri-apps/api/window");

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

  const setWindowSize = async (type: "sm" | "lg") => {
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

  const closeWindow = () => {
    import("@tauri-apps/api/window").then(async ({ appWindow }) => {
      await emit("change-device", {
        type: "video",
        device: {
          label: "None",
          index: -1,
          kind: "video",
        },
      });
      appWindow.close();
    });
  };

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
      <div className="opacity-0 group-hover:opacity-100 absolute top-3 left-1/2 transform -translate-x-1/2 bg-gray-800 rounded-xl z-20 grid grid-cols-3 overflow-hidden">
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
        className="absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
      />
    </div>
  );
};

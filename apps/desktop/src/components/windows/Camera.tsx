"use client";

import React, { use, useEffect, useRef, useState } from "react";
import { Device, useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { CloseX } from "@/components/icons/CloseX";
import { Flip } from "@/components/icons/Flip";
import { emit } from "@tauri-apps/api/event";
import { Expand } from "../icons/Expand";
import { Minimize } from "../icons/Minimize";
import { Squircle } from "../icons/Squircle";

export const Camera = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { selectedVideoDevice, devices } = useMediaDevices();
  const [isLoading, setIsLoading] = useState(true);
  const tauriWindowImport = import("@tauri-apps/api/window");
  const [cameraMirrored, setCameraMirrored] = useState(
    typeof window !== "undefined"
      ? localStorage.getItem("cameraMirrored") || "false"
      : "false"
  );
  const [overlaySize, setOverlaySize] = useState<"sm" | "lg">("sm");
  const [overlayShape, setOverlayShape] = useState<"round" | "square">(
    (localStorage.getItem("cameraOverlayShape") as "round" | "square") ||
      "round"
  );

  useEffect(
    () => localStorage.setItem("cameraOverlayShape", overlayShape),
    [overlayShape]
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
            setOverlaySize(type);
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

  const getOverlayBorderRadius = () => {
    if (overlayShape === "round") return "9999px";
    if (overlaySize === "sm") return "3rem";
    else return "4rem";
  };

  const handleContextMenu = async () => {
    const { showMenu } = await import("tauri-plugin-context-menu");
    const videoDevices = devices.filter(
      (device) => device.kind === "videoinput"
    );

    const select = async (device: Device | null) => {
      emit("change-device", { type: "videoinput", device: device }).catch(
        (error) => console.log("Failed to emit change-device event:", error)
      );
    };

    const menuItems = [
      {
        label: "Select Video:",
        disabled: true,
      },
      ...videoDevices.map((device) => ({
        label: device.label,
        checked: selectedVideoDevice.index === device.index,
        event: async () => select(device),
      })),
      {
        is_separator: true,
      },
      {
        label: "Refresh Overlay",
        event: async () => {
          if (typeof window !== "undefined") {
            window.location.reload();
          }
        },
      },
      {
        label: "Close Overlay",
        checked: selectedVideoDevice === null,
        event: async () => select(null),
      },
    ];

    await showMenu({
      items: [...menuItems],
      ...(videoDevices.length === 0 && {
        items: [{ label: "Nothing found." }],
      }),
    });
  };

  return (
    <div
      data-tauri-drag-region
      onContextMenu={(e) => {
        e.preventDefault();
        handleContextMenu();
      }}
      className="cursor-move group w-full h-full bg-gray-200 m-0 p-0 relative overflow-hidden flex items-center justify-center outline-none focus:outline-none border-2 border-sm border-gray-300"
      style={{ borderRadius: getOverlayBorderRadius() }}
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
      <div className="opacity-0 group-hover:opacity-100 absolute top-5 left-1/2 transform -translate-x-1/2 bg-gray-800 bg-opacity-75 backdrop-blur-sm rounded-xl z-20 grid grid-cols-4 overflow-hidden transition-opacity">
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
            await setWindowSize(overlaySize === "sm" ? "lg" : "sm");
          }}
          className="h-full flex items-center justify-center p-2 hover:bg-gray-900"
        >
          <div>
            {overlaySize === "sm" && (
              <Expand className="w-5 h-5 stroke-gray-200" />
            )}
            {overlaySize === "lg" && (
              <Minimize className="w-5 h-5 stroke-gray-200" />
            )}
          </div>
        </div>
        <div
          onClick={() => {
            setOverlayShape(overlayShape === "round" ? "square" : "round");
          }}
          className="h-full flex items-center justify-center p-2 hover:bg-gray-900"
        >
          {overlayShape === "round" && (
            <div>
              <Squircle className="w-5 h-5 stroke-gray-200" />
            </div>
          )}
          {overlayShape === "square" && (
            <span className="w-3 h-3 bg-gray-200 rounded-full"></span>
          )}
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
        className={
          "absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
        }
        style={{ borderRadius: getOverlayBorderRadius() }}
      />
    </div>
  );
};

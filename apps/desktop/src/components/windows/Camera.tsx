import React, { useEffect, useRef, useState } from "react";
import { useMediaDevices } from "@/utils/recording/MediaDeviceContext";
import { CloseX } from "@/components/icons/CloseX";
import { Focus } from "@/components/icons/Focus";
import * as bodyPix from "@tensorflow-models/body-pix";
import "@tensorflow/tfjs-backend-webgl";

export const Camera = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isBackgroundBlur, setIsBackgroundBlur] = useState(false);
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

  useEffect(() => {
    let animationFrameId;

    const loadBodyPixAndApply = async () => {
      if (!videoRef.current || !canvasRef.current) return;

      const net = await bodyPix.load({
        architecture: "MobileNetV1",
        outputStride: 16,
        multiplier: 0.75,
        quantBytes: 2,
      });

      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");

      // Create an off-screen canvas for blurring the background
      const offscreenCanvas = document.createElement("canvas");
      offscreenCanvas.width = canvas.width;
      offscreenCanvas.height = canvas.height;
      const offscreenCtx = offscreenCanvas.getContext("2d");

      const draw = async () => {
        if (
          !videoRef.current ||
          !canvasRef.current ||
          video.paused ||
          video.ended
        )
          return;

        if (isBackgroundBlur) {
          const segmentation = await net.segmentPerson(video, {
            internalResolution: "medium",
            segmentationThreshold: 0.7,
            flipHorizontal: false,
            maxDetections: 1,
            scoreThreshold: 0.2,
            nmsRadius: 20,
          });

          // Draw the video frame to the off-screen canvas
          offscreenCtx.drawImage(video, 0, 0);
          offscreenCtx.filter = "blur(8px)";
          ctx.filter = "none";

          // Apply the blurred image from the off-screen canvas to the main canvas
          ctx.drawImage(offscreenCanvas, 0, 0);

          // Now draw the clear part (foreground) by using the mask from segmentation
          const foregroundColor = { r: 0, g: 0, b: 0, a: 0 }; // Change these values as per your requirement
          const foreground = bodyPix.toMask(segmentation, foregroundColor);
          ctx.putImageData(foreground, 0, 0);
        } else {
          // If background blur is not enabled, simply draw the video frame
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        }

        animationFrameId = requestAnimationFrame(draw);
      };

      if (video.readyState >= 2) {
        draw();
      } else {
        video.onloadedmetadata = () => {
          draw();
        };
      }
    };

    loadBodyPixAndApply();

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [isBackgroundBlur, selectedVideoDevice]);

  const toggleBackgroundBlur = () => {
    setIsBackgroundBlur(!isBackgroundBlur);
  };

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
    import("@tauri-apps/api/window").then(({ appWindow }) => {
      appWindow.close();
    });
  };

  return (
    <div
      data-tauri-drag-region
      className="group w-full h-full bg-gray-200 rounded-full m-0 p-0 relative overflow-hidden flex items-center justify-center border-none outline-none focus:outline-none"
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
      <div className="opacity-0 group-hover:opacity-100 absolute bottom-3 left-1/2 transform -translate-x-1/2 bg-gray-800 rounded-xl z-20 grid grid-cols-4 overflow-hidden">
        <div className="h-full flex items-center justify-center p-2 hover:bg-gray-900">
          <button
            onClick={() => {
              closeWindow();
            }}
          >
            <CloseX className="w-5 h-5 stroke-gray-200" />
          </button>
        </div>
        <div className="h-full flex items-center justify-center p-2 hover:bg-gray-900">
          <button
            onClick={async () => {
              await setWindowSize("sm");
            }}
            className="w-2 h-2 m-0 p-0 bg-gray-200 rounded-full"
          ></button>
        </div>
        <div className="h-full flex items-center justify-center p-2 hover:bg-gray-900">
          <button
            onClick={async () => {
              await setWindowSize("lg");
            }}
            className="w-4 h-4 bg-gray-200 rounded-full"
          ></button>
        </div>
        <div className="h-full flex items-center justify-center p-2 hover:bg-gray-900">
          <button
            onClick={() => {
              toggleBackgroundBlur();
            }}
          >
            <Focus className="w-5 h-5 stroke-gray-200" />
          </button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
        style={{ display: isBackgroundBlur ? "block" : "none" }}
      ></canvas>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
        style={{ visibility: isBackgroundBlur ? "hidden" : "visible" }}
      />
    </div>
  );
};

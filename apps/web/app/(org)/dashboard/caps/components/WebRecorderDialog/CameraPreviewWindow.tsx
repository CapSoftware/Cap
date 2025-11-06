"use client";

import { X, Maximize2, Circle, Square, RectangleHorizontal, FlipHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

type CameraPreviewSize = "sm" | "lg";
type CameraPreviewShape = "round" | "square" | "full";

interface CameraPreviewWindowProps {
  cameraId: string;
  onClose: () => void;
}

export const CameraPreviewWindow = ({
  cameraId,
  onClose,
}: CameraPreviewWindowProps) => {
  const [size, setSize] = useState<CameraPreviewSize>("sm");
  const [shape, setShape] = useState<CameraPreviewShape>("round");
  const [mirrored, setMirrored] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const pipAutoEnteredRef = useRef(false);

  useEffect(() => {
    setMounted(true);
    return () => {
      setMounted(false);
    };
  }, []);

  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: cameraId },
          },
        });

        streamRef.current = stream;
        
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        const calculateInitialPosition = () => {
          const padding = 20;
          const base = size === "sm" ? 230 : 400;
          const barHeight = 52;
          const windowWidth = base;
          const windowHeight = base + barHeight;
          const x = padding;
          const y = window.innerHeight - windowHeight - padding;
          setPosition({ x, y });
        };

        setTimeout(calculateInitialPosition, 100);
      } catch (err) {
        console.error("Failed to start camera", err);
      }
    };

    startCamera();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [cameraId]);

  useEffect(() => {
    if (videoRef.current && streamRef.current && !videoRef.current.srcObject) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [position]);

  useEffect(() => {
    if (position) {
      const padding = 20;
      const base = size === "sm" ? 230 : 400;
      const barHeight = 52;
      const windowWidth = base;
      const windowHeight = base + barHeight;
      
      setPosition((prev) => {
        if (!prev) return { x: padding, y: window.innerHeight - windowHeight - padding };
        const maxX = window.innerWidth - windowWidth;
        const maxY = window.innerHeight - windowHeight;
        return {
          x: Math.max(0, Math.min(prev.x, maxX)),
          y: Math.max(0, Math.min(prev.y, maxY)),
        };
      });
    }
  }, [size]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-controls]')) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    setIsDragging(true);
    setDragStart({
      x: e.clientX - (position?.x || 0),
      y: e.clientY - (position?.y || 0),
    });
  }, [position]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;

    const newX = e.clientX - dragStart.x;
    const newY = e.clientY - dragStart.y;

    const base = size === "sm" ? 230 : 400;
    const barHeight = 52;
    const aspectRatio = videoDimensions
      ? videoDimensions.width / videoDimensions.height
      : 1;
    const windowWidth =
      shape === "full" ? (aspectRatio >= 1 ? base * aspectRatio : base) : base;
    const windowHeight =
      shape === "full" ? (aspectRatio >= 1 ? base : base / aspectRatio) : base;
    const totalWidth = windowWidth;
    const totalHeight = windowHeight + barHeight;
    const maxX = window.innerWidth - totalWidth;
    const maxY = window.innerHeight - totalHeight;

    setPosition({
      x: Math.max(0, Math.min(newX, maxX)),
      y: Math.max(0, Math.min(newY, maxY)),
    });
  }, [isDragging, dragStart, size, shape, videoDimensions]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const handleClose = useCallback(async () => {
    if (videoRef.current && document.pictureInPictureElement === videoRef.current) {
      try {
        await document.exitPictureInPicture();
      } catch (err) {
        console.error("Failed to exit Picture-in-Picture", err);
      }
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!videoRef.current || !videoDimensions) return;

    const video = videoRef.current;

    const enterPictureInPicture = async () => {
      if (!video || !document.pictureInPictureEnabled) return;
      
      const isAlreadyInPip = document.pictureInPictureElement === video;
      if (isAlreadyInPip) return;

      try {
        await video.requestPictureInPicture();
        pipAutoEnteredRef.current = true;
      } catch (err) {
        console.error("Failed to enter Picture-in-Picture", err);
      }
    };

    const exitPictureInPicture = async () => {
      if (!video || document.pictureInPictureElement !== video) return;

      try {
        await document.exitPictureInPicture();
        pipAutoEnteredRef.current = false;
      } catch (err) {
        console.error("Failed to exit Picture-in-Picture", err);
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        enterPictureInPicture();
      } else if (pipAutoEnteredRef.current) {
        exitPictureInPicture();
      }
    };

    const handleWindowBlur = () => {
      enterPictureInPicture();
    };

    const handleWindowFocus = () => {
      if (pipAutoEnteredRef.current) {
        exitPictureInPicture();
      }
    };

    const handlePipEnter = () => {
      pipAutoEnteredRef.current = true;
    };

    const handlePipLeave = () => {
      pipAutoEnteredRef.current = false;
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    video.addEventListener("enterpictureinpicture", handlePipEnter);
    video.addEventListener("leavepictureinpicture", handlePipLeave);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
      video.removeEventListener("enterpictureinpicture", handlePipEnter);
      video.removeEventListener("leavepictureinpicture", handlePipLeave);
    };
  }, [videoDimensions]);

  if (!mounted || !position) {
    return null;
  }

  const base = size === "sm" ? 230 : 400;
  const barHeight = 52;
  const aspectRatio = videoDimensions
    ? videoDimensions.width / videoDimensions.height
    : 1;

  const windowWidth =
    shape === "full" ? (aspectRatio >= 1 ? base * aspectRatio : base) : base;
  const windowHeight =
    shape === "full" ? (aspectRatio >= 1 ? base : base / aspectRatio) : base;
  const totalHeight = windowHeight + barHeight;

  const borderRadius =
    shape === "round" ? "9999px" : size === "sm" ? "3rem" : "4rem";


  return createPortal(
    <div
      ref={containerRef}
      data-camera-preview
      className="fixed z-[600] group cursor-move pointer-events-auto"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${windowWidth}px`,
        height: `${totalHeight}px`,
        borderRadius,
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        handleMouseDown(e);
      }}
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      <div
        className="flex relative flex-col w-full h-full cursor-move"
        style={{ borderRadius }}
      >
        <div className="h-13">
          <div className="flex flex-row justify-center items-center">
            <div
              data-controls
              className="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10 pointer-events-auto"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose();
                }}
                className="p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12"
              >
                <X className="size-5.5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSize((s) => (s === "sm" ? "lg" : "sm"));
                }}
                className={clsx(
                  "p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12",
                  size === "lg" && "bg-gray-3 text-gray-12"
                )}
              >
                <Maximize2 className="size-5.5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShape((s) =>
                    s === "round" ? "square" : s === "square" ? "full" : "round"
                  );
                }}
                className={clsx(
                  "p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12",
                  shape !== "round" && "bg-gray-3 text-gray-12"
                )}
              >
                {shape === "round" && <Circle className="size-5.5" />}
                {shape === "square" && <Square className="size-5.5" />}
                {shape === "full" && <RectangleHorizontal className="size-5.5" />}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMirrored((m) => !m);
                }}
                className={clsx(
                  "p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12 hover:bg-gray-3 hover:text-gray-12",
                  mirrored && "bg-gray-3 text-gray-12"
                )}
              >
                <FlipHorizontal className="size-5.5" />
              </button>
            </div>
          </div>
        </div>

        <div
          className={clsx(
            "relative overflow-hidden border-none shadow-lg bg-black text-gray-12",
            shape === "round" ? "rounded-full" : "rounded-3xl"
          )}
          style={{
            width: shape === "full" ? `${windowWidth}px` : `${base}px`,
            height: shape === "full" ? `${windowHeight}px` : `${base}px`,
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={clsx(
              "absolute inset-0 w-full h-full object-cover pointer-events-none",
              shape === "round" ? "rounded-full" : "rounded-3xl"
            )}
            style={videoDimensions ? {
              transform: mirrored ? "scaleX(-1)" : "scaleX(1)",
            } : { display: "none" }}
            onLoadedMetadata={() => {
              if (videoRef.current) {
                setVideoDimensions({
                  width: videoRef.current.videoWidth,
                  height: videoRef.current.videoHeight,
                });
              }
            }}
          />
          {!videoDimensions && (
            <div className="w-full flex-1 flex items-center justify-center">
              <div className="text-gray-11">Loading camera...</div>
            </div>
          )}
        </div>
      </div>
    </div>
  , document.body);
};


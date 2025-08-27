"use client";

import { useEffect, useRef, useState, useId } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Maximize2,
  Circle,
  Square,
  RectangleHorizontal,
  FlipHorizontal,
} from "lucide-react";

type CameraSize = "sm" | "lg";
type CameraShape = "round" | "square" | "full";

interface CameraPreviewProps {
  stream: MediaStream;
  onClose?: () => void;
}

interface CameraPreviewState {
  size: CameraSize;
  shape: CameraShape;
  mirrored: boolean;
}

export function CameraPreview({ stream, onClose }: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLButtonElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [position, setPosition] = useState({ x: 20, y: 20 }); // Start at bottom-left
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [mounted, setMounted] = useState(false);
  const instructionsId = useId();

  useEffect(() => {
    setMounted(true);
  }, []);

  const [state, setState] = useState<CameraPreviewState>({
    size: "sm",
    shape: "round",
    mirrored: false,
  });

  useEffect(() => {
    if (mounted && videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream, mounted]);

  useEffect(() => {
    // Position at bottom-left of viewport for visibility
    const baseSize = state.size === "sm" ? 200 : 320;
    const height = baseSize + 60;
    setPosition({
      x: 20,
      y: window.innerHeight - height - 100, // 100px from bottom
    });
  }, [state.size]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent dialog from closing
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      setIsDragging(true);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const step = 10; // pixels to move per keypress
    const baseSize = state.size === "sm" ? 200 : 320;
    const width = baseSize;
    const height = baseSize + 60;
    const maxX = window.innerWidth - width;
    const maxY = window.innerHeight - height;

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        setPosition((prev) => ({
          ...prev,
          y: Math.max(0, prev.y - step),
        }));
        break;
      case "ArrowDown":
        e.preventDefault();
        setPosition((prev) => ({
          ...prev,
          y: Math.min(maxY, prev.y + step),
        }));
        break;
      case "ArrowLeft":
        e.preventDefault();
        setPosition((prev) => ({
          ...prev,
          x: Math.max(0, prev.x - step),
        }));
        break;
      case "ArrowRight":
        e.preventDefault();
        setPosition((prev) => ({
          ...prev,
          x: Math.min(maxX, prev.x + step),
        }));
        break;
      case "Escape":
        if (onClose) {
          onClose();
        }
        break;
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const handleKeyUp = (e: React.KeyboardEvent) => {
    // Handle activation keys for consistency with click behavior
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const newX = e.clientX - dragOffset.x;
        const newY = e.clientY - dragOffset.y;

        // Keep within viewport bounds (still relative to viewport since it's fixed positioned)
        const baseSize = state.size === "sm" ? 200 : 320;
        const width = baseSize;
        const height = baseSize + 60; // base height + controls height
        const maxX = window.innerWidth - width;
        const maxY = window.innerHeight - height;

        setPosition({
          x: Math.max(0, Math.min(newX, maxX)),
          y: Math.max(0, Math.min(newY, maxY)),
        });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, dragOffset, state.size]);

  const baseSize = state.size === "sm" ? 200 : 320;
  const containerSize = { width: baseSize, height: baseSize + 60 }; // +60 for controls

  const getBorderRadius = () => {
    if (state.shape === "round") return "9999px";
    if (state.size === "sm") return "24px";
    return "32px";
  };

  const cameraPreviewContent = (
    <button
      ref={containerRef}
      type="button"
      className={`fixed group ${
        isDragging ? "cursor-grabbing" : "cursor-grab"
      } focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50`}
      style={{
        left: position.x,
        top: position.y,
        width: containerSize.width,
        height: containerSize.height,
        zIndex: 99999999999, // Much higher than dialog z-[501]
        pointerEvents: 'auto', // Ensure pointer events work
      }}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onClick={handleClick}
      aria-label="Draggable camera preview. Use arrow keys to move, Escape to close."
      aria-describedby={instructionsId}
    >
      {/* Controls */}
      <div className="h-14 flex items-center justify-center">
        <div className="flex gap-1 p-1 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-800 border border-gray-600">
          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Size toggle */}
          <button
            type="button"
            onClick={() =>
              setState((prev) => ({
                ...prev,
                size: prev.size === "sm" ? "lg" : "sm",
              }))
            }
            className={`p-2 rounded-lg transition-colors ${
              state.size === "lg"
                ? "bg-gray-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-700"
            }`}
          >
            <Maximize2 className="w-5 h-5" />
          </button>

          {/* Shape toggle */}
          <button
            type="button"
            onClick={() =>
              setState((prev) => ({
                ...prev,
                shape:
                  prev.shape === "round"
                    ? "square"
                    : prev.shape === "square"
                    ? "full"
                    : "round",
              }))
            }
            className={`p-2 rounded-lg transition-colors ${
              state.shape !== "round"
                ? "bg-gray-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-700"
            }`}
          >
            {state.shape === "round" && <Circle className="w-5 h-5" />}
            {state.shape === "square" && <Square className="w-5 h-5" />}
            {state.shape === "full" && (
              <RectangleHorizontal className="w-5 h-5" />
            )}
          </button>

          {/* Mirror toggle */}
          <button
            type="button"
            onClick={() =>
              setState((prev) => ({ ...prev, mirrored: !prev.mirrored }))
            }
            className={`p-2 rounded-lg transition-colors ${
              state.mirrored
                ? "bg-gray-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-700"
            }`}
          >
            <FlipHorizontal className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Video container */}
      <div
        className="flex-1 relative overflow-hidden shadow-lg border-2 border-gray-600"
        style={{
          borderRadius: state.shape === "round" ? "50%" : getBorderRadius(),
          height: baseSize,
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover"
          style={{
            transform: state.mirrored ? "scaleX(-1)" : "scaleX(1)",
            borderRadius: state.shape === "round" ? "50%" : "inherit",
          }}
        />
      </div>

      {/* Hidden instructions for screen readers */}
      <div id={instructionsId} className="sr-only">
        Camera preview controls: Use arrow keys to move the preview around the
        screen. Press Escape to close the preview.
      </div>
    </button>
  );

  if (!mounted) return null;

  return createPortal(cameraPreviewContent, document.body);
}

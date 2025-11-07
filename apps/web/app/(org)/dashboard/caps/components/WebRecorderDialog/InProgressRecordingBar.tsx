"use client";

import clsx from "clsx";
import {
  Mic,
  MicOff,
  MoreVertical,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  StopCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type { RecorderPhase } from "./web-recorder-types";

const phaseMessages: Partial<Record<RecorderPhase, string>> = {
  recording: "Recording",
  paused: "Paused",
  creating: "Finishing up",
  converting: "Converting",
  uploading: "Uploading",
};

const clamp = (value: number, min: number, max: number) => {
  if (Number.isNaN(value)) return min;
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
};

const formatDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

interface InProgressRecordingBarProps {
  phase: RecorderPhase;
  durationMs: number;
  hasAudioTrack: boolean;
  onStop: () => void | Promise<void>;
  onPause?: () => void | Promise<void>;
  onResume?: () => void | Promise<void>;
}

const DRAG_PADDING = 12;

export const InProgressRecordingBar = ({
  phase,
  durationMs,
  hasAudioTrack,
  onStop,
  onPause,
  onResume,
}: InProgressRecordingBarProps) => {
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 24 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedPositionRef = useRef(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    if (!mounted || initializedPositionRef.current) return;
    if (typeof window === "undefined") return;

    const raf = window.requestAnimationFrame(() => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const maxX = window.innerWidth - rect.width - DRAG_PADDING;
      initializedPositionRef.current = true;
      setPosition({
        x: clamp((window.innerWidth - rect.width) / 2, DRAG_PADDING, maxX),
        y: DRAG_PADDING * 2,
      });
    });

    return () => {
      if (typeof window !== "undefined") {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [mounted]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      setPosition((prev) => {
        const maxX = window.innerWidth - rect.width - DRAG_PADDING;
        const maxY = window.innerHeight - rect.height - DRAG_PADDING;
        return {
          x: clamp(prev.x, DRAG_PADDING, maxX),
          y: clamp(prev.y, DRAG_PADDING, maxY),
        };
      });
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement)?.closest("[data-no-drag]") ||
        (event.button !== 0)) {
        return;
      }

      event.preventDefault();
      setIsDragging(true);
      dragOffsetRef.current = {
        x: event.clientX - position.x,
        y: event.clientY - position.y,
      };
    },
    [position],
  );

  useEffect(() => {
    if (!isDragging || typeof window === "undefined") {
      return undefined;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const width = rect?.width ?? 360;
      const height = rect?.height ?? 64;
      const maxX = window.innerWidth - width - DRAG_PADDING;
      const maxY = window.innerHeight - height - DRAG_PADDING;

      setPosition({
        x: clamp(event.clientX - dragOffsetRef.current.x, DRAG_PADDING, maxX),
        y: clamp(event.clientY - dragOffsetRef.current.y, DRAG_PADDING, maxY),
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  if (!mounted || typeof document === "undefined") {
    return null;
  }

  const isPaused = phase === "paused";
  const canStop = phase === "recording" || isPaused;
  const showTimer = phase === "recording" || isPaused;
  const statusText = showTimer
    ? formatDuration(durationMs)
    : phaseMessages[phase] ?? "Processing";

  const handleStop = () => {
    onStop();
  };

  const handlePauseToggle = () => {
    if (isPaused) {
      if (!onResume) return;
      void onResume();
      return;
    }

    if (phase === "recording" && onPause) {
      void onPause();
    }
  };

  const handleRestart = () => {
    console.log("Restart recording clicked (not implemented yet)");
  };

  const canTogglePause =
    (phase === "recording" && Boolean(onPause)) ||
    (isPaused && Boolean(onResume));

  return createPortal(
    <div
      ref={containerRef}
      className={clsx(
        "fixed z-[650] pointer-events-auto animate-in fade-in",
        isDragging ? "cursor-grabbing" : "cursor-move",
      )}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      onMouseDown={handlePointerDown}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-row items-stretch rounded-[0.9rem] border border-gray-5 bg-gray-1 text-gray-12 shadow-[0_16px_60px_rgba(0,0,0,0.35)] min-w-[360px]">
        <div className="flex flex-row justify-between flex-1 gap-3 p-[0.25rem]">
          <button
            type="button"
            data-no-drag
            onClick={handleStop}
            disabled={!canStop}
            className="py-[0.25rem] px-[0.5rem] text-red-300 gap-[0.35rem] flex flex-row items-center rounded-lg transition-opacity disabled:opacity-60"
          >
            <StopCircle className="size-5" />
            <span className="font-[500] text-[0.875rem] tabular-nums">
              {statusText}
            </span>
          </button>

          <div className="flex gap-1 items-center" data-no-drag>
            <div className="flex relative justify-center items-center w-8 h-8">
              {hasAudioTrack ? (
                <>
                  <Mic className="size-5 text-gray-12" />
                  <div className="absolute bottom-1 left-1 right-1 h-0.5 bg-gray-10 overflow-hidden rounded-full">
                    <div
                      className="absolute inset-0 bg-blue-9 transition-transform duration-200"
                      style={{
                        transform: hasAudioTrack
                          ? "translateX(0%)"
                          : "translateX(-100%)",
                      }}
                    />
                  </div>
                </>
              ) : (
                <MicOff className="text-gray-7 size-5" />
              )}
            </div>

            <ActionButton
              data-no-drag
              onClick={handlePauseToggle}
              disabled={!canTogglePause}
              aria-label={isPaused ? "Resume recording" : "Pause recording"}
            >
              {isPaused ? (
                <PlayCircle className="size-5" />
              ) : (
                <PauseCircle className="size-5" />
              )}
            </ActionButton>
            <ActionButton data-no-drag onClick={handleRestart}>
              <RotateCcw className="size-5" />
            </ActionButton>
          </div>
        </div>
        <div
          className="cursor-move flex items-center justify-center p-[0.25rem] border-l border-gray-5 text-gray-9"
          aria-hidden
        >
          <MoreVertical className="size-5" />
        </div>
      </div>
    </div>,
    document.body,
  );
};

const ActionButton = ({ className, ...props }: ComponentProps<"button">) => (
  <button
    {...props}
    type="button"
    className={clsx(
      "p-[0.25rem] rounded-lg transition-all",
      "text-gray-11",
      "h-8 w-8 flex items-center justify-center",
      "hover:bg-gray-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-9",
      "disabled:opacity-50 disabled:cursor-not-allowed",
      className,
    )}
  />
);

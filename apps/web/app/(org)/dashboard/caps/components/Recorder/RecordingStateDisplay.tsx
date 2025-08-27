"use client";

type RecordingState = "idle" | "recording" | "stopped" | "uploading";

interface RecordingStateDisplayProps {
  recordingState: RecordingState;
  recordingTime: number;
  uploadProgress?: number;
}

export function RecordingStateDisplay({
  recordingState,
  recordingTime,
  uploadProgress = 0,
}: RecordingStateDisplayProps) {
  const formatTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  };

  if (recordingState === "recording") {
    return (
      <div className="flex items-center gap-3">
        <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
        <span className="text-red-500 font-medium text-lg">
          {formatTime(recordingTime)}
        </span>
      </div>
    );
  }

  if (recordingState === "uploading") {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
          <span className="text-blue-500 font-medium text-lg">
            Uploading ({uploadProgress}%)
          </span>
        </div>
      </div>
    );
  }

  return null;
}
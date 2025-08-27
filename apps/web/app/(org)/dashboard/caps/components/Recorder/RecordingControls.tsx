"use client";

import { Button } from "@cap/ui";

type RecordingState = "idle" | "recording" | "stopped" | "uploading";

interface RecordingControlsProps {
  recordingState: RecordingState;
  isStartingRecording?: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
}

export function RecordingControls({
  recordingState,
  isStartingRecording,
  onStartRecording,
  onStopRecording,
}: RecordingControlsProps) {
  if (recordingState === "idle") {
    return (
      <div className="flex items-center space-x-1 w-full px-3">
        <Button
          variant="blue"
          onClick={onStartRecording}
          disabled={isStartingRecording}
          className="flex flex-grow justify-center items-center"
        >
          {isStartingRecording ? "Starting..." : "Start Recording"}
        </Button>
      </div>
    );
  }

  if (recordingState === "recording") {
    return (
      <div className="flex items-center space-x-1 w-full px-3">
        <Button
          variant="destructive"
          onClick={onStopRecording}
          className="flex flex-grow justify-center items-center bg-red-500 hover:bg-red-600"
        >
          Stop Recording
        </Button>
      </div>
    );
  }

  if (recordingState === "uploading") {
    return (
      <div className="flex items-center space-x-1 w-full px-3">
        <Button
          variant="outline"
          disabled
          className="flex flex-grow justify-center items-center"
        >
          Uploading...
        </Button>
      </div>
    );
  }

  return null;
}

"use client";

import { Button } from "@cap/ui";

type RecordingState = "idle" | "recording" | "stopped";

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
      <div className="flex justify-center px-3">
        <Button
          variant="primary"
          onClick={onStartRecording}
          disabled={isStartingRecording}
          className="px-6"
        >
          {isStartingRecording ? "Starting..." : "Start Recording"}
        </Button>
      </div>
    );
  }

  if (recordingState === "recording") {
    return (
      <div className="flex justify-center px-3">
        <Button
          variant="destructive"
          onClick={onStopRecording}
          className="bg-red-500 hover:bg-red-600 px-6"
        >
          Stop Recording
        </Button>
      </div>
    );
  }

  return null;
}
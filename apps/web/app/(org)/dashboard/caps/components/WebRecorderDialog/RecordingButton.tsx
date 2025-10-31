"use client";

import { Button } from "@cap/ui";
import { PlayIcon } from "lucide-react";

interface RecordingButtonProps {
  isRecording: boolean;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}

export const RecordingButton = ({
  isRecording,
  disabled = false,
  onStart,
  onStop,
}: RecordingButtonProps) => {
  return (
    <div className="flex items-center space-x-1 w-full">
      <Button
        variant="blue"
        size="md"
        disabled={disabled}
        onClick={isRecording ? onStop : onStart}
        className="flex flex-grow justify-center items-center"
      >
        {isRecording ? (
          "Stop Recording"
        ) : (
          <>
            <PlayIcon className="size-[0.8rem] mr-1.5" />
            Start recording
          </>
        )}
      </Button>
    </div>
  );
};


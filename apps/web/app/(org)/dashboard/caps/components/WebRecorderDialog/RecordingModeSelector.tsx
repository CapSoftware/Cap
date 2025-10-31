"use client";

import {
  SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cap/ui";
import {
  CameraIcon,
  Globe,
  MonitorIcon,
  RectangleHorizontal,
  type LucideIcon,
} from "lucide-react";

export type RecordingMode = "fullscreen" | "window" | "tab" | "camera";

interface RecordingModeSelectorProps {
  mode: RecordingMode;
  disabled?: boolean;
  onModeChange: (mode: RecordingMode) => void;
}

export const RecordingModeSelector = ({
  mode,
  disabled = false,
  onModeChange,
}: RecordingModeSelectorProps) => {
  const recordingModeOptions: Record<
    RecordingMode,
    {
      label: string;
      icon: LucideIcon;
    }
  > = {
    fullscreen: {
      label: "Full Screen",
      icon: MonitorIcon,
    },
    window: {
      label: "Window",
      icon: RectangleHorizontal,
    },
    tab: {
      label: "Current tab",
      icon: Globe,
    },
    camera: {
      label: "Camera only",
      icon: CameraIcon,
    },
  };

  return (
    <div className="flex flex-col gap-[0.25rem] items-stretch text-[--text-primary]">
      <SelectRoot
        value={mode}
        onValueChange={(value) => {
          onModeChange(value as RecordingMode);
        }}
        disabled={disabled}
      >
        <SelectTrigger className="relative flex flex-row items-center h-[2rem] px-[0.375rem] border border-gray-3 rounded-lg w-full disabled:text-gray-11 transition-colors overflow-hidden z-10 font-normal text-[0.875rem] bg-transparent hover:bg-transparent focus:bg-transparent focus:border-gray-3 hover:border-gray-3 text-[--text-primary] [&>svg]:hidden">
          <SelectValue
            placeholder="Select recording mode"
            className="flex w-full items-center gap-[0.375rem] text-left truncate"
          />
        </SelectTrigger>
        <SelectContent className="z-[502]">
          {Object.entries(recordingModeOptions).map(([value, option]) => {
            const OptionIcon = option.icon;

            return (
              <SelectItem key={value} value={value}>
                <span className="flex items-center gap-2">
                  <OptionIcon className="size-4 text-gray-11" />
                  {option.label}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </SelectRoot>
    </div>
  );
};

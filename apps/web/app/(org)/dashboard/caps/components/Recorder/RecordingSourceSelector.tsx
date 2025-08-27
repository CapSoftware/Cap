"use client";

import { Monitor, AppWindow, Crop } from "lucide-react";

type RecordingSource = "screen" | "window" | "area";

interface RecordingSourceSelectorProps {
  selectedSource: RecordingSource;
  onSourceSelect: (source: RecordingSource) => void;
  disabled?: boolean;
}

interface TargetTypeButtonProps {
  selected: boolean;
  icon: React.ElementType;
  name: string;
  onClick: () => void;
  disabled?: boolean;
}

function TargetTypeButton({
  selected,
  icon: Icon,
  name,
  onClick,
  disabled,
}: TargetTypeButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`
        flex-1 text-center bg-gray-3 hover:bg-gray-4 flex flex-col 
        ring-offset-gray-1 ring-offset-2 items-center justify-end gap-2 
        py-1.5 px-2 rounded-lg transition-all
        ${
          selected
            ? "bg-gray-3 text-white ring-blue-9 ring-1"
            : "ring-transparent ring-0"
        }
        ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
      `}
    >
      <Icon
        className={`
          size-6 transition-colors
          ${selected ? "text-gray-12" : "text-gray-9"}
        `}
      />
      <p className="text-xs text-gray-12">{name}</p>
    </button>
  );
}

export function RecordingSourceSelector({
  selectedSource,
  onSourceSelect,
  disabled,
}: RecordingSourceSelectorProps) {
  return (
    <div className="flex flex-row gap-2 items-stretch w-full text-xs text-gray-11 px-3">
      <TargetTypeButton
        selected={selectedSource === "screen"}
        icon={Monitor}
        onClick={() => onSourceSelect("screen")}
        name="Display"
        disabled={disabled}
      />
      <TargetTypeButton
        selected={selectedSource === "window"}
        icon={AppWindow}
        onClick={() => onSourceSelect("window")}
        name="Window"
        disabled={disabled}
      />
      <TargetTypeButton
        selected={selectedSource === "area"}
        icon={Crop}
        onClick={() => onSourceSelect("area")}
        name="Area"
        disabled={disabled}
      />
    </div>
  );
}
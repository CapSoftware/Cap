"use client";

import { Monitor, RectangleEllipsis } from "lucide-react";

type RecordingSource = "screen" | "window";

interface RecordingSourceSelectorProps {
  selectedSource: RecordingSource;
  onSourceSelect: (source: RecordingSource) => void;
  disabled?: boolean;
}

export function RecordingSourceSelector({
  selectedSource,
  onSourceSelect,
  disabled,
}: RecordingSourceSelectorProps) {
  return (
    <div className="px-3">
      <div className="flex flex-row items-center rounded-[0.5rem] relative border h-8 transition-all duration-500 border-gray-3">
        <div
          className="w-1/2 absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-300 outline-offset-2 rounded-[0.6rem] overflow-hidden"
          style={{
            transform:
              selectedSource === "window" ? "translateX(100%)" : undefined,
            transitionTimingFunction: "cubic-bezier(0.785, 0.135, 0.15, 0.86)",
          }}
        >
          <div className="flex-1 bg-gray-2" />
        </div>

        <button
          type="button"
          className="group flex-1 text-gray-11 py-1 z-10 data-[selected='true']:text-gray-12 disabled:text-gray-10 peer focus:outline-none transition-colors duration-100 w-full text-nowrap overflow-hidden px-2 flex gap-2 items-center justify-center text-sm"
          data-selected={selectedSource === "screen"}
          disabled={disabled}
          onClick={() => onSourceSelect("screen")}
        >
          <Monitor className="shrink-0 size-4" />
          <span className="truncate">Display</span>
        </button>

        <button
          type="button"
          className="group flex-1 text-gray-11 py-1 z-10 data-[selected='true']:text-gray-12 disabled:text-gray-10 peer focus:outline-none transition-colors duration-100 w-full text-nowrap overflow-hidden px-2 flex gap-2 items-center justify-center text-sm"
          data-selected={selectedSource === "window"}
          disabled={disabled}
          onClick={() => onSourceSelect("window")}
        >
          <RectangleEllipsis className="shrink-0 size-4" />
          <span className="truncate">Window</span>
        </button>
      </div>
    </div>
  );
}

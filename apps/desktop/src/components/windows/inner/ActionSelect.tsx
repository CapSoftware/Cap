import React, { ReactNode } from "react";

export const ActionSelect = ({
  iconEnabled = null,
  iconDisabled = null,
  width = "auto",
  active = true,
  showStatus = false,
  status = "on",
  options = [],
  selectedValue = null,
  onSelect,
  onStatusClick,
}: {
  iconEnabled?: ReactNode;
  iconDisabled?: ReactNode;
  width?: "full" | "auto";
  active?: boolean;
  showStatus?: boolean;
  status: "on" | "off";
  options: { value: string | number; label: string; disabled?: boolean }[];
  selectedValue?: string | number;
  onSelect: (value: string | number) => void;
  onStatusClick?: (currentStatus: "on" | "off") => void;
}) => (
  <div className={`flex-grow ${width === "full" ? "w-full" : "w-auto"}`}>
    <div
      className={`
        ${active ? "bg-white hover:bg-gray-100" : "bg-gray-200 hover:bg-white"}
        border-gray-300 w-full h-[50px] py-2 px-4 text-[14px] border-2 flex items-center rounded-[15px] transition-all shadow-sm shadow-[0px 0px 180px rgba(255, 255, 255, 0.18)] cursor-pointer
      `}
    >
      <div className="flex items-center min-w-0 flex-grow h-full">
        <span className="flex-shrink-0 mr-2">
          {status === "off" && iconDisabled ? iconDisabled : iconEnabled}
        </span>
        <select
          className="bg-transparent border-none appearance-none w-full min-w-0 cursor-pointer h-full truncate"
          value={selectedValue || -1}
          onChange={(e) => onSelect(e.target.value)}
        >
          {options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {showStatus && (
        <div
          className={
            onStatusClick ? "transition-transform active:scale-95" : ""
          }
          onClick={(e) => {
            e.stopPropagation();
            onStatusClick?.(status);
          }}
        >
          <span
            className={`${
              status === "on"
                ? "bg-tertiary text-primary"
                : "bg-red-600 text-white"
            } h-5 w-8 font-medium text-xs rounded-full flex items-center justify-center`}
          >
            <span>{status === "on" ? "On" : "Off"}</span>
          </span>
        </div>
      )}
    </div>
  </div>
);

import React, { ReactNode, useRef, MouseEvent, useMemo, useState, useEffect } from "react";

type Status = { text: string; enabled: boolean };

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
  onStatusClick?: () => void;
}) => {
  const selectRef = useRef<HTMLSelectElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  return (
    <div className={`flex-grow ${width === "full" ? "w-full" : "w-auto"}`}>
      <div
        className={`
          ${active ? "bg-white hover:bg-gray-100" : "bg-gray-200 hover:bg-white"}
          border-gray-300 w-full h-[50px] py-2 px-4 text-[14px] border-2 flex items-center rounded-[15px] transition-all shadow-sm shadow-[0px 0px 180px rgba(255, 255, 255, 0.18)] cursor-pointer
        `}
      >
        <div className="flex items-center min-w-0 flex-grow h-full">
          <span className="flex-shrink-0 mr-2">{iconEnabled}</span>
          <select
            ref={selectRef}
            className="bg-transparent border-none focus:outline-none appearance-none w-full min-w-0 cursor-pointer h-full truncate"
            value={selectedValue || -1}
            onChange={(e) => onSelect(e.target.value)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {showStatus && (
          <div 
            ref={statusRef} 
            onClick={(e) => {
              e.stopPropagation();
              onStatusClick?.();
            }}
          >
            <span
              className={`${
                status === "on" ? "bg-tertiary text-primary" : "bg-red-600 text-white" 
              } h-5 px-2 font-medium text-xs rounded-full flex items-center justify-center`}
            >
              <span>{status === "on" ? "On" : "Off"}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
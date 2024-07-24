import React, { ReactNode } from "react";

export const ActionSelect = ({
  icon,
  label,
  width,
  active,
  recordingOption = false,
  optionName,
  options = [],
  selectedValue,
  onSelect,
}: {
  icon?: ReactNode;
  label?: string;
  width?: string;
  active?: boolean;
  recordingOption?: boolean;
  optionName?: string;
  options: { value: string; label: string }[];
  selectedValue: string;
  onSelect: (value: string) => void;
}) => {
  return (
    <div className="flex-grow">
      <div
        className={`${
          active ? "bg-white hover:bg-gray-100" : "bg-gray-200 hover:bg-white"
        } border-gray-300 w-full h-[50px] py-2 px-4 text-[14px] border-2 flex items-center rounded-[15px] transition-all shadow-sm shadow-[0px 0px 180px rgba(255, 255, 255, 0.18)]`}
      >
        <div className="flex items-center min-w-0 flex-grow">
          <span className="flex-shrink-0 mr-2">{icon}</span>
          <select
            className="bg-transparent border-none focus:outline-none appearance-none w-full min-w-0"
            value={selectedValue}
            onChange={(e) => onSelect(e.target.value)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {recordingOption && (
          <div className="flex-shrink-0 ml-2">
            <span
              className={`${
                selectedValue === "none"
                  ? "bg-red-600 text-white"
                  : "bg-tertiary text-primary"
              } h-5 w-8 font-medium text-xs rounded-full flex items-center justify-center`}
            >
              {selectedValue === "none" ? "Off" : "On"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
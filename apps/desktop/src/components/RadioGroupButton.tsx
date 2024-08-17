import React, { useState } from "react";

interface RadioButtonGroupProps {
  options: { label: string; value: string }[];
  selectedValue: string | null;
  onSelect: (value: string) => void;
}

export const RadioButtonGroup: React.FC<RadioButtonGroupProps> = ({
  options,
  selectedValue,
  onSelect,
}) => {
  return (
    <div className="inline-flex flex-wrap gap-1" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`
            flex-grow px-2 py-1 text-xs font-medium rounded-md transition-all duration-200 active:scale-90
            ${
              selectedValue === option.value
                ? "bg-primary text-white hover:bg-primary-2"
                : "bg-white text-gray-900 hover:bg-gray-100"
            }
            border border-gray-200
          `}
          onClick={() => onSelect(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
};

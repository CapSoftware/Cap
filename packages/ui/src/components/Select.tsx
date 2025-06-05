"use client";

import * as React from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { ChevronDown } from "lucide-react";
import clsx from "clsx";

export interface SelectOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export const Select: React.FC<SelectProps> = ({
  value,
  onChange,
  options,
  placeholder = "Select...",
  disabled = false,
  className = "",
}) => {
  return (
    <RadixSelect.Root
      value={value}
      onValueChange={onChange}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        className={clsx(
          "flex items-center px-2 h-10 rounded-xl border bg-gray-3 border-gray-4 hover:bg-gray-5 group hover:border-gray-6 focus:ring-0 focus:ring-offset-0 focus:outline-0 text-[15px]",
          disabled && "opacity-50 cursor-not-allowed",
          className
        )}
        aria-label={placeholder}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon asChild>
          <ChevronDown className="ml-2 text-gray-9" size={18} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Content className="z-50 mt-2 rounded-xl border shadow-lg bg-gray-3 border-gray-4">
        <RadixSelect.Viewport>
          {options.map((opt) => (
            <RadixSelect.Item
              key={opt.value}
              value={opt.value}
              className="flex gap-2 items-center justify-start p-2 text-[15px] rounded-xl cursor-pointer text-gray-12 hover:bg-gray-4"
            >
              {opt.icon && <span className="mr-2">{opt.icon}</span>}
              <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
            </RadixSelect.Item>
          ))}
        </RadixSelect.Viewport>
      </RadixSelect.Content>
    </RadixSelect.Root>
  );
};

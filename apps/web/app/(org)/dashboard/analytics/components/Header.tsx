"use client";

import { Select } from "@cap/ui";
import type { AnalyticsRange } from "../types";
import { faCalendar } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

interface HeaderProps {
  options: { value: AnalyticsRange; label: string }[];
  value: AnalyticsRange;
  onChange: (value: AnalyticsRange) => void;
  isLoading?: boolean;
}

export default function Header({
  options,
  value,
  onChange,
  isLoading,
}: HeaderProps) {
  return (
    <>
      <div className="flex gap-2 items-center">
        <Select
          placeholder="Select a range"
          variant="light"
          icon={<FontAwesomeIcon icon={faCalendar} />}
          size="md"
          options={options}
          value={value}
          onValueChange={(val) => onChange(val as AnalyticsRange)}
          disabled={isLoading}
        />
      </div>
    </>
  );
}

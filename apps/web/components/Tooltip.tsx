"use client";

import React, { ReactNode } from "react";
import { Tooltip as ReactTooltip } from "react-tooltip";

interface TooltipProps {
  children: ReactNode;
  content: string;
  id?: string;
  className?: string;
}

export const Tooltip = ({
  children,
  content,
  id,
  className,
}: TooltipProps) => {
  const tooltipId = id || `tooltip-${Math.random().toString(36).substring(2, 9)}`;

  return (
    <>
      <div
        data-tooltip-id={tooltipId}
        data-tooltip-content={content}
        className={className}
      >
        {children}
      </div>
      <ReactTooltip
        id={tooltipId}
        place="right"
        className="z-50 px-2 py-1 text-xs border border-gray-200 bg-gray-50 text-gray-600 rounded shadow-lg"
      />
    </>
  );
}

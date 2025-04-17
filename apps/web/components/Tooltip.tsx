"use client";

import { detectPlatform } from "@/utils/platform";
import { classNames } from "@cap/utils";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

const Tooltip = ({
  children,
  content,
  className,
  position = "top",
  kbd,
  disable,
}: {
  children: React.ReactNode;
  content: string;
  className?: string;
  position?: "top" | "bottom" | "left" | "right";
  kbd?: string[];
  disable?: boolean;
}) => {
  if (disable) {
    return <>{children}</>;
  }
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={position}
          className={classNames(
            "select-none rounded-lg flex items-center gap-2 TooltipContent bg-gray-50 border border-gray-200 px-3 py-2 text-xs leading-none shadow-sm shadow-gray-300/50 data-[state=delayed-open]:data-[side=bottom]:animate-slideUpAndFade data-[state=delayed-open]:data-[side=left]:animate-slideRightAndFade data-[state=delayed-open]:data-[side=right]:animate-slideLeftAndFade data-[state=delayed-open]:data-[side=top]:animate-slideDownAndFade",
            className
          )}
          sideOffset={5}
        >
          {content}
          {kbd && (
            <div className="flex gap-1 items-center">
              {kbd.map((key, index) => (
                <div className="flex justify-center items-center bg-gray-100 rounded-md border border-gray-300 shadow-sm size-5 shadow-gray-300/50" key={index}>
                  <kbd className="text-xs text-gray-400">{key}</kbd>
                </div>
              ))}
            </div>
          )}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
};

Tooltip.displayName = TooltipPrimitive.Root.displayName;

export { Tooltip };

"use client";

import { classNames } from "@cap/utils";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

const Tooltip = ({
  children,
  content,
  className,
  position = "top",
  disable,
}: {
  children: React.ReactNode;
  content: string;
  className?: string;
  position?: "top" | "bottom" | "left" | "right";
  disable?: boolean;
}) => {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger disabled={disable} asChild>
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={position}
          className={classNames(
            "select-none rounded bg-white px-[15px] py-2.5 text-[15px] leading-none text-violet11 shadow-[hsl(206_22%_7%_/_35%)_0px_10px_38px_-10px,_hsl(206_22%_7%_/_20%)_0px_10px_20px_-15px] will-change-[transform,opacity] data-[state=delayed-open]:data-[side=bottom]:animate-slideUpAndFade data-[state=delayed-open]:data-[side=left]:animate-slideRightAndFade data-[state=delayed-open]:data-[side=right]:animate-slideLeftAndFade data-[state=delayed-open]:data-[side=top]:animate-slideDownAndFade",
            className
          )}
          sideOffset={5}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-white" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
};

Tooltip.displayName = TooltipPrimitive.Root.displayName;

export { Tooltip };

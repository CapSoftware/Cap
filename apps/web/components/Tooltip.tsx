"use client";

import { classNames } from "@cap/utils";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";

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
			<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Content
					side={position}
					className={classNames(
						"select-none rounded-lg z-[60] text-gray-12 font-medium flex items-center gap-2 TooltipContent bg-gray-1 border border-gray-3 px-3 py-2 text-xs leading-none shadow-sm shadow-gray-3/50 data-[state=delayed-open]:data-[side=bottom]:animate-slideUpAndFade data-[state=delayed-open]:data-[side=left]:animate-slideRightAndFade data-[state=delayed-open]:data-[side=right]:animate-slideLeftAndFade data-[state=delayed-open]:data-[side=top]:animate-slideDownAndFade",
						className,
					)}
					sideOffset={5}
				>
					{content}
					{kbd && (
						<div className="flex gap-1 items-center">
							{kbd.map((key, index) => (
								<div
									className="flex justify-center items-center px-1 rounded-md border shadow-sm bg-gray-3 border-gray-4 size-5 min-w-fit shadow-gray-3/50"
									key={index}
								>
									<kbd className="text-[11px] text-gray-10">{key}</kbd>
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

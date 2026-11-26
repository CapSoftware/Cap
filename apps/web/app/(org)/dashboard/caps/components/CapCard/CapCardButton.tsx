"use client";

import { Button } from "@cap/ui";
import clsx from "clsx";
import type { MouseEvent } from "react";
import React from "react";
import { Tooltip } from "@/components/Tooltip";

interface CapCardButtonProps {
	tooltipContent: string;
	onClick?: (e: MouseEvent) => void;
	disabled?: boolean;
	className: string;
	icon: React.JSX.Element;
	asChild?: boolean;
}

export const CapCardButton = ({
	tooltipContent,
	onClick = () => {},
	disabled,
	className,
	icon,
	asChild,
}: CapCardButtonProps) => {
	return (
		<Tooltip key={tooltipContent} content={tooltipContent}>
			<Button
				onClick={onClick}
				disabled={disabled}
				asChild={asChild}
				className={clsx(
					"!size-7 !p-0 min-w-fit rounded-lg bg-gray-1 border-gray-4 text-gray-12 shadow-[0_1px_3px_rgba(0,0,0,0.12)] hover:bg-gray-2 hover:border-gray-6",
					className,
				)}
				variant="white"
				size="sm"
				aria-label={tooltipContent}
			>
				{React.cloneElement(icon, {
					className: clsx(icon.props.className, "size-3.5"),
				})}
			</Button>
		</Tooltip>
	);
};

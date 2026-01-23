"use client";

import { Button } from "@inflight/ui";
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
					`!size-8 hover:bg-gray-5 hover:border-gray-7 rounded-full min-w-fit !p-0`,
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

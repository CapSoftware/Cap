"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface ChartLineIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface ChartLineIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const variants: Variants = {
	normal: {
		pathLength: 1,
		opacity: 1,
	},
	animate: {
		pathLength: [0, 1],
		opacity: [0, 1],
		transition: {
			delay: 0.15,
			duration: 0.3,
			opacity: { delay: 0.1 },
		},
	},
};

const ChartLineIcon = forwardRef<ChartLineIconHandle, ChartLineIconProps>(
	({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
		const controls = useAnimation();
		const isControlledRef = useRef(false);

		useImperativeHandle(ref, () => {
			isControlledRef.current = true;

			return {
				startAnimation: () => controls.start("animate"),
				stopAnimation: () => controls.start("normal"),
			};
		});

		const handleMouseEnter = useCallback(
			(e: React.MouseEvent<HTMLDivElement>) => {
				if (!isControlledRef.current) {
					controls.start("animate");
				} else {
					onMouseEnter?.(e);
				}
			},
			[controls, onMouseEnter],
		);

		const handleMouseLeave = useCallback(
			(e: React.MouseEvent<HTMLDivElement>) => {
				if (!isControlledRef.current) {
					controls.start("normal");
				} else {
					onMouseLeave?.(e);
				}
			},
			[controls, onMouseLeave],
		);

		return (
			<div
				className={cn(className)}
				onMouseEnter={handleMouseEnter}
				onMouseLeave={handleMouseLeave}
				{...props}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M3 3v16a2 2 0 0 0 2 2h16" />
					<motion.path
						d="m7 13 3-3 4 4 5-5"
						variants={variants}
						animate={controls}
					/>
				</svg>
			</div>
		);
	},
);

ChartLineIcon.displayName = "ChartLineIcon";

export default ChartLineIcon;

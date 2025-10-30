"use client";

import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface CapIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface CapIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const CapIcon = forwardRef<CapIconHandle, CapIconProps>(
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
				<motion.svg
					width={size}
					height={size}
					transition={{ type: "spring", stiffness: 50, damping: 10 }}
					viewBox="0 0 32 32"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					xmlns="http://www.w3.org/2000/svg"
				>
					<motion.circle
						cx="16"
						cy="16"
						r="12"
						fill="none"
						stroke="currentColor"
					/>
					<motion.circle
						initial={{
							fill: "none",
							opacity: 0.5,
						}}
						variants={{
							normal: { fill: "none", opacity: 0.5 },
							animate: { fill: "currentColor", opacity: [0.3, 1, 0.3, 1] },
						}}
						animate={controls}
						transition={{ duration: 0.5, ease: "easeInOut" }}
						cx="16"
						cy="16"
						r="8"
						fill="none"
						stroke="currentColor"
					/>
				</motion.svg>
			</div>
		);
	},
);

CapIcon.displayName = "CapIcon";

export default CapIcon;

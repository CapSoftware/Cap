"use client";

import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface RecordIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface RecordIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const RecordIcon = forwardRef<RecordIconHandle, RecordIconProps>(
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
					xmlns="http://www.w3.org/2000/svg"
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					transition={{ type: "spring", stiffness: 50, damping: 10 }}
				>
					<rect x="2" y="3" width="20" height="14" rx="2" />
					<line x1="8" y1="21" x2="16" y2="21" />
					<line x1="12" y1="17" x2="12" y2="21" />
					<motion.circle
						cx="12"
						cy="10"
						r="2"
						variants={{
							normal: { scale: 1, opacity: 0, fill: "currentColor" },
							animate: {
								scale: [1, 1.25, 1],
								opacity: [0, 1, 0.8, 1],
								fill: "currentColor",
							},
						}}
						animate={controls}
						transition={{ duration: 0.9, ease: "easeInOut" }}
					/>
				</motion.svg>
			</div>
		);
	},
);

RecordIcon.displayName = "RecordIcon";

export default RecordIcon;

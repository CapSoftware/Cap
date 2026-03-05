"use client";

import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface CodeIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface CodeIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const CodeIcon = forwardRef<CodeIconHandle, CodeIconProps>(
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
					<motion.polyline
						points="16 18 22 12 16 6"
						variants={{
							normal: { x: 0 },
							animate: { x: 2 },
						}}
						transition={{
							type: "spring",
							stiffness: 300,
							damping: 15,
						}}
						animate={controls}
					/>
					<motion.polyline
						points="8 6 2 12 8 18"
						variants={{
							normal: { x: 0 },
							animate: { x: -2 },
						}}
						transition={{
							type: "spring",
							stiffness: 300,
							damping: 15,
						}}
						animate={controls}
					/>
				</svg>
			</div>
		);
	},
);

CodeIcon.displayName = "CodeIcon";

export default CodeIcon;

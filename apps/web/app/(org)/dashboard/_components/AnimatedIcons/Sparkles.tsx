"use client";

import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface SparklesIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface SparklesIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const SparklesIcon = forwardRef<SparklesIconHandle, SparklesIconProps>(
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
					<motion.path
						d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
						variants={{
							normal: { scale: 1, rotate: 0 },
							animate: {
								scale: [1, 1.1, 1],
								rotate: [0, 10, -10, 0],
							},
						}}
						animate={controls}
						transition={{ duration: 0.6, ease: "easeInOut" }}
					/>
					<motion.path
						d="M20 3v4"
						variants={{
							normal: { opacity: 0.7 },
							animate: { opacity: [0.7, 1, 0.7] },
						}}
						animate={controls}
						transition={{ duration: 0.4, delay: 0.1 }}
					/>
					<motion.path
						d="M22 5h-4"
						variants={{
							normal: { opacity: 0.7 },
							animate: { opacity: [0.7, 1, 0.7] },
						}}
						animate={controls}
						transition={{ duration: 0.4, delay: 0.2 }}
					/>
					<motion.path
						d="M4 17v2"
						variants={{
							normal: { opacity: 0.7 },
							animate: { opacity: [0.7, 1, 0.7] },
						}}
						animate={controls}
						transition={{ duration: 0.4, delay: 0.15 }}
					/>
					<motion.path
						d="M5 18H3"
						variants={{
							normal: { opacity: 0.7 },
							animate: { opacity: [0.7, 1, 0.7] },
						}}
						animate={controls}
						transition={{ duration: 0.4, delay: 0.25 }}
					/>
				</motion.svg>
			</div>
		);
	},
);

SparklesIcon.displayName = "SparklesIcon";

export default SparklesIcon;

"use client";

import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface CogIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface CogIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const CogIcon = forwardRef<CogIconHandle, CogIconProps>(
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
					variants={{
						normal: {
							rotate: 0,
						},
						animate: {
							rotate: 180,
						},
					}}
					animate={controls}
				>
					<path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" />
					<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
					<path d="M12 2v2" />
					<path d="M12 22v-2" />
					<path d="m17 20.66-1-1.73" />
					<path d="M11 10.27 7 3.34" />
					<path d="m20.66 17-1.73-1" />
					<path d="m3.34 7 1.73 1" />
					<path d="M14 12h8" />
					<path d="M2 12h2" />
					<path d="m20.66 7-1.73 1" />
					<path d="m3.34 17 1.73-1" />
					<path d="m17 3.34-1 1.73" />
					<path d="m11 13.73-4 6.93" />
				</motion.svg>
			</div>
		);
	},
);

CogIcon.displayName = "CogIcon";

export default CogIcon;

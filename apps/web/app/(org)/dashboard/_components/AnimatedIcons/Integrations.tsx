"use client";

import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes, MouseEvent } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

import type { CogIconHandle } from "./Cog";

interface IntegrationsIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const IntegrationsIcon = forwardRef<CogIconHandle, IntegrationsIconProps>(
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
			(event: MouseEvent<HTMLDivElement>) => {
				if (!isControlledRef.current) {
					controls.start("animate");
				} else {
					onMouseEnter?.(event);
				}
			},
			[controls, onMouseEnter],
		);

		const handleMouseLeave = useCallback(
			(event: MouseEvent<HTMLDivElement>) => {
				if (!isControlledRef.current) {
					controls.start("normal");
				} else {
					onMouseLeave?.(event);
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
					transition={{ type: "spring", stiffness: 80, damping: 12 }}
					variants={{
						normal: {
							scale: 1,
							y: 0,
						},
						animate: {
							scale: 1.05,
							y: -1,
						},
					}}
					animate={controls}
				>
					<path d="M9 2v6" />
					<path d="M15 2v6" />
					<path d="M5 10h14" />
					<path d="M17 10a5 5 0 1 1-10 0" />
					<path d="M12 17v5" />
					<motion.circle
						cx="12"
						cy="15"
						r="1.5"
						fill="currentColor"
						variants={{
							normal: { opacity: 0.6, scale: 0.9 },
							animate: { opacity: 1, scale: 1.1 },
						}}
						animate={controls}
					/>
				</motion.svg>
			</div>
		);
	},
);

IntegrationsIcon.displayName = "IntegrationsIcon";

export default IntegrationsIcon;

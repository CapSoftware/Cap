"use client";

import type { Transition } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface AppsIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface AppsIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const transition: Transition = {
	type: "spring",
	stiffness: 260,
	damping: 18,
};

const AppsIcon = forwardRef<AppsIconHandle, AppsIconProps>(
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
				if (!isControlledRef.current) controls.start("animate");
				else onMouseEnter?.(e);
			},
			[controls, onMouseEnter],
		);

		const handleMouseLeave = useCallback(
			(e: React.MouseEvent<HTMLDivElement>) => {
				if (!isControlledRef.current) controls.start("normal");
				else onMouseLeave?.(e);
			},
			[controls, onMouseLeave],
		);

		return (
			<div
				role="presentation"
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
					aria-hidden="true"
				>
					<rect width="7" height="7" x="3" y="3" rx="1.5" />
					<rect width="7" height="7" x="3" y="14" rx="1.5" />
					<rect width="7" height="7" x="14" y="14" rx="1.5" />
					<motion.rect
						width="7"
						height="7"
						x="14"
						y="3"
						rx="1.5"
						style={{ transformBox: "fill-box", transformOrigin: "center" }}
						variants={{
							normal: { rotate: 0, scale: 1 },
							animate: { rotate: 45, scale: 0.9 },
						}}
						animate={controls}
						transition={transition}
					/>
				</svg>
			</div>
		);
	},
);

AppsIcon.displayName = "AppsIcon";

export default AppsIcon;

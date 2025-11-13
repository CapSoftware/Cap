"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface ClapIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface ClapIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const variants: Variants = {
	normal: {
		rotate: 0,
		originX: "4px",
		originY: "20px",
	},
	animate: {
		rotate: [-10, -10, 0],
		transition: {
			duration: 0.8,
			times: [0, 0.5, 1],
			ease: "easeInOut",
		},
	},
};

const clapVariants: Variants = {
	normal: {
		rotate: 0,
		originX: "3px",
		originY: "11px",
	},
	animate: {
		rotate: [0, -10, 16, 0],
		transition: {
			duration: 0.4,
			times: [0, 0.3, 0.6, 1],
			ease: "easeInOut",
		},
	},
};

const ClapIcon = forwardRef<ClapIconHandle, ClapIconProps>(
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
					style={{ overflow: "visible" }}
				>
					<motion.g animate={controls} variants={variants}>
						<motion.g animate={controls} variants={clapVariants}>
							<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
							<path d="m6.2 5.3 3.1 3.9" />
							<path d="m12.4 3.4 3.1 4" />
						</motion.g>
						<path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
					</motion.g>
				</svg>
			</div>
		);
	},
);

ClapIcon.displayName = "ClapIcon";

export default ClapIcon;

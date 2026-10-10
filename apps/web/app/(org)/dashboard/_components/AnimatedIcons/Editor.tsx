"use client";

import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface EditorIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface EditorIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const EditorIcon = forwardRef<EditorIconHandle, EditorIconProps>(
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
				>
					<rect x="2" y="3" width="20" height="18" rx="2" />
					<line x1="6" y1="9" x2="14" y2="9" />
					<line x1="6" y1="14" x2="11" y2="14" />
					<motion.line
						y1="6"
						y2="18"
						variants={{
							normal: { x1: 17, x2: 17 },
							animate: { x1: [17, 7, 17], x2: [17, 7, 17] },
						}}
						animate={controls}
						transition={{ duration: 0.9, ease: "easeInOut" }}
					/>
				</motion.svg>
			</div>
		);
	},
);

EditorIcon.displayName = "EditorIcon";

export default EditorIcon;

"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface MessageCircleMoreIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface MessageCircleMoreIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const dotVariants: Variants = {
	normal: {
		opacity: 1,
	},
	animate: (custom: number) => ({
		opacity: [1, 0, 0, 1, 1, 0, 0, 1],
		transition: {
			opacity: {
				times: [
					0,
					0.1,
					0.1 + custom * 0.1,
					0.1 + custom * 0.1 + 0.1,
					0.5,
					0.6,
					0.6 + custom * 0.1,
					0.6 + custom * 0.1 + 0.1,
				],
				duration: 1.5,
			},
		},
	}),
};

const MessageCircleMoreIcon = forwardRef<
	MessageCircleMoreIconHandle,
	MessageCircleMoreIconProps
>(({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
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
				<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
				<motion.path
					d="M8 12h.01"
					variants={dotVariants}
					animate={controls}
					custom={0}
				/>
				<motion.path
					d="M12 12h.01"
					variants={dotVariants}
					animate={controls}
					custom={1}
				/>
				<motion.path
					d="M16 12h.01"
					variants={dotVariants}
					animate={controls}
					custom={2}
				/>
			</svg>
		</div>
	);
});

MessageCircleMoreIcon.displayName = "MessageCircleMoreIcon";

export default MessageCircleMoreIcon;

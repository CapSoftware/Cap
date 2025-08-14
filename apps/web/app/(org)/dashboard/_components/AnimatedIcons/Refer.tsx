import { type MotionProps, motion, type Variants } from "framer-motion";
import React, { forwardRef, useImperativeHandle } from "react";

const referVariants: Variants = {
	normal: {
		rotate: 0,
	},
	animate: {
		rotate: [0, 5, -5, 0],
		transition: {
			duration: 0.5,
		},
	},
};

export interface ReferIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface ReferIconProps extends MotionProps {
	size?: number;
}

const ReferIcon = forwardRef<ReferIconHandle, ReferIconProps>(
	({ size = 28, ...props }, ref) => {
		const [isAnimating, setIsAnimating] = React.useState(false);

		const startAnimation = () => {
			if (isAnimating) return;
			setIsAnimating(true);
		};

		const stopAnimation = () => {
			setIsAnimating(false);
		};

		useImperativeHandle(ref, () => ({
			startAnimation,
			stopAnimation,
		}));

		return (
			<motion.svg
				width={size}
				height={size}
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
				xmlns="http://www.w3.org/2000/svg"
				variants={referVariants}
				animate={isAnimating ? "animate" : "normal"}
				onAnimationComplete={() => setIsAnimating(false)}
				{...props}
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={1.5}
					d="M20 12v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8M12 22V12M12 12L7 7M12 12l5-5M2 7h20v5H2V7zM12 2v5"
				/>
			</motion.svg>
		);
	},
);

ReferIcon.displayName = "ReferIcon";

export default ReferIcon;

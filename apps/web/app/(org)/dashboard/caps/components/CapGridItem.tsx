"use client";

import {
	motion,
	type TargetAndTransition,
	useReducedMotion,
} from "framer-motion";
import type { ReactNode } from "react";

const leaveAnimation: TargetAndTransition = {
	opacity: 0,
	scale: 0.94,
	filter: "blur(2px)",
	transition: { duration: 0.18, ease: [0.4, 0, 1, 1] },
};
const swapOut: TargetAndTransition = {
	opacity: 0,
	transition: { duration: 0 },
};

export function CapGridItem({
	id,
	children,
	layoutDependency,
	returning,
}: {
	id: string;
	children: ReactNode;
	layoutDependency: unknown;
	returning: boolean;
}) {
	const reduceMotion = useReducedMotion();
	return (
		<motion.div
			layout={reduceMotion ? false : "position"}
			layoutDependency={layoutDependency}
			variants={{
				exit: (leaving: ReadonlySet<string> | undefined) =>
					leaving?.has(id)
						? reduceMotion
							? { opacity: 0, transition: { duration: 0.1 } }
							: leaveAnimation
						: swapOut,
			}}
			initial={returning && !reduceMotion ? { opacity: 0, scale: 0.97 } : false}
			animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
			exit="exit"
			transition={{
				layout: { type: "spring", stiffness: 520, damping: 44 },
				opacity: { duration: 0.2, ease: "easeOut" },
				scale: { duration: 0.2, ease: "easeOut" },
			}}
			className="min-w-0"
		>
			{children}
		</motion.div>
	);
}

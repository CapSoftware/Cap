"use client";

import { classNames } from "@cap/utils";
import { motion, useReducedMotion } from "motion/react";

export type ShareView = "classic" | "timeline";

const OPTIONS: { value: ShareView; label: string }[] = [
	{ value: "classic", label: "Player" },
	{ value: "timeline", label: "Timeline" },
];

interface ShareViewToggleProps {
	view: ShareView;
	onChange: (view: ShareView) => void;
	disabled?: boolean;
	/** Warms the lazily-loaded timeline chunk before the user commits. */
	prefetch?: () => void;
}

export function ShareViewToggle({
	view,
	onChange,
	disabled = false,
	prefetch,
}: ShareViewToggleProps) {
	const reduceMotion = useReducedMotion() ?? false;

	return (
		<div className="inline-flex items-center gap-0.5 p-0.5 rounded-full border border-gray-5 bg-gray-3">
			{OPTIONS.map((option) => {
				const active = option.value === view;
				return (
					<button
						key={option.value}
						type="button"
						disabled={disabled}
						aria-pressed={active}
						title={`${option.label} (T)`}
						onClick={() => {
							if (active) return;
							onChange(option.value);
						}}
						onPointerEnter={prefetch}
						onFocus={prefetch}
						className={classNames(
							"relative px-3 py-1 rounded-full text-xs font-medium transition-colors duration-150",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
							disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
							active ? "text-gray-12" : "text-gray-11 hover:text-gray-12",
						)}
					>
						{active && (
							<motion.span
								layoutId="share-view-thumb"
								className="absolute inset-0 rounded-full border border-gray-5 bg-white shadow-sm"
								transition={
									reduceMotion
										? { duration: 0 }
										: { type: "spring", stiffness: 500, damping: 30 }
								}
							/>
						)}
						<span className="relative z-10">{option.label}</span>
					</button>
				);
			})}
		</div>
	);
}

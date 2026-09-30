"use client";

import { useUploadProgress } from "./upload-progress";

const RADIUS = 5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Ring({
	fraction,
	className,
}: {
	fraction: number;
	className?: string;
}) {
	return (
		<svg viewBox="0 0 14 14" className={className} aria-hidden="true">
			<circle
				cx="7"
				cy="7"
				r={RADIUS}
				fill="none"
				stroke="currentColor"
				strokeOpacity="0.25"
				strokeWidth="2"
			/>
			<circle
				cx="7"
				cy="7"
				r={RADIUS}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeDasharray={CIRCUMFERENCE}
				strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
				transform="rotate(-90 7 7)"
				className="transition-[stroke-dashoffset] duration-300 ease-out"
			/>
		</svg>
	);
}

/**
 * Ring + percent for a media comment that is still uploading. Subscribes per
 * comment id and renders nothing once the entry clears, so a settled card
 * sheds it without the card itself re-rendering for progress ticks.
 *
 * "overlay": dark pill for on-media placement (video card corner).
 * "inline": quiet text-toned row for the voice pill.
 */
export function UploadProgressIndicator({
	commentId,
	variant,
}: {
	commentId: string;
	variant: "overlay" | "inline";
}) {
	const fraction = useUploadProgress(commentId);
	if (fraction === undefined) return null;

	// Below 1% the pipeline is still converting/thumbnailing — no bytes moving.
	const label =
		fraction < 0.01 ? "Preparing" : `${Math.round(fraction * 100)}%`;

	if (variant === "overlay") {
		return (
			<span
				data-upload-progress
				className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white"
			>
				<Ring fraction={fraction} className="size-3 shrink-0" />
				{label}
			</span>
		);
	}

	return (
		<span
			data-upload-progress
			className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-gray-10"
		>
			<Ring fraction={fraction} className="size-3 shrink-0" />
			{label}
		</span>
	);
}

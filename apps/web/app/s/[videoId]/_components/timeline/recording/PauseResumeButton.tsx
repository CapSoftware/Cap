"use client";

/** Pause/resume toggle shared by the voice bar, camera panel and screen card. */
export function PauseResumeButton({
	paused,
	onToggle,
	shape,
}: {
	paused: boolean;
	onToggle: () => void;
	shape: "square" | "round";
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-label={paused ? "Resume recording" : "Pause recording"}
			aria-pressed={paused}
			className={`flex items-center justify-center ring-1 ring-gray-4 transition-colors ${
				shape === "round" ? "size-8 rounded-full" : "size-7 rounded-lg"
			} ${paused ? "bg-gray-3 text-gray-9" : "bg-gray-2 text-gray-12"}`}
		>
			{paused ? (
				<svg
					viewBox="0 0 16 16"
					className="size-3.5"
					fill="currentColor"
					aria-hidden="true"
				>
					<path d="M4.5 3.06c0-.84.92-1.36 1.64-.93l7.02 4.19a1.08 1.08 0 0 1 0 1.86l-7.02 4.19a1.08 1.08 0 0 1-1.64-.93V3.06Z" />
				</svg>
			) : (
				<svg
					viewBox="0 0 16 16"
					className="size-3.5"
					fill="currentColor"
					aria-hidden="true"
				>
					<rect x="3.5" y="2.5" width="3.4" height="11" rx="1" />
					<rect x="9.1" y="2.5" width="3.4" height="11" rx="1" />
				</svg>
			)}
		</button>
	);
}

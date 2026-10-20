"use client";

import { LogoSpinner } from "@cap/ui";

export function RecordingInProgressOverlay({
	onConfirmStopped,
	isConfirmingStopped = false,
	confirmStoppedError,
	className,
	variant = "solid",
}: {
	onConfirmStopped: () => void;
	isConfirmingStopped?: boolean;
	confirmStoppedError?: string | null;
	className?: string;
	variant?: "solid" | "overlay";
}) {
	const backgroundClassName =
		variant === "overlay" ? "bg-black/70 backdrop-blur-[1px]" : "bg-black";

	return (
		<div
			className={`flex flex-col gap-3 justify-center items-center rounded-xl ${backgroundClassName} ${className ?? ""}`}
		>
			<div className="flex gap-2.5 items-center">
				<span className="relative flex size-3">
					<span className="absolute inline-flex w-full h-full bg-red-500 rounded-full opacity-75 animate-ping" />
					<span className="relative inline-flex rounded-full size-3 bg-red-500" />
				</span>
				<span className="text-white font-semibold text-base sm:text-lg">
					Recording in progress
				</span>
			</div>
			<p className="text-white/50 text-xs sm:text-sm text-center max-w-xs leading-relaxed">
				This video is still being recorded and will be available once the
				recording has stopped.
			</p>
			<button
				type="button"
				onClick={onConfirmStopped}
				disabled={isConfirmingStopped}
				className="mt-1 text-white/30 text-xs hover:text-white/60 transition-colors underline underline-offset-2"
			>
				{isConfirmingStopped
					? "Finishing recording..."
					: "I have stopped recording"}
			</button>
			{confirmStoppedError && (
				<p className="text-xs text-red-200/80 text-center max-w-xs">
					{confirmStoppedError}
				</p>
			)}
		</div>
	);
}

export function PreparingVideoOverlay({
	className,
	label = "Preparing video...",
}: {
	className?: string;
	label?: string;
}) {
	return (
		<div
			className={`flex flex-col gap-3 justify-center items-center bg-black rounded-xl ${className ?? ""}`}
		>
			<LogoSpinner className="w-8 h-auto animate-spin sm:w-10" />
			<p className="text-white/50 text-sm">{label}</p>
		</div>
	);
}

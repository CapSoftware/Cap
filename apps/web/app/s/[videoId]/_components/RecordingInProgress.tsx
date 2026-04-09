"use client";

import { LogoSpinner } from "@cap/ui";

export function RecordingInProgressOverlay({
	onConfirmStopped,
	className,
}: {
	onConfirmStopped: () => void;
	className?: string;
}) {
	return (
		<div
			className={`flex flex-col gap-3 justify-center items-center bg-black rounded-xl ${className ?? ""}`}
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
				className="mt-1 text-white/30 text-xs hover:text-white/60 transition-colors underline underline-offset-2"
			>
				I have stopped recording
			</button>
		</div>
	);
}

export function PreparingVideoOverlay({ className }: { className?: string }) {
	return (
		<div
			className={`flex flex-col gap-3 justify-center items-center bg-black rounded-xl ${className ?? ""}`}
		>
			<LogoSpinner className="w-8 h-auto animate-spin sm:w-10" />
			<p className="text-white/50 text-sm">Preparing video...</p>
		</div>
	);
}

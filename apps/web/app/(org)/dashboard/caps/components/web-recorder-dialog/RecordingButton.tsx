"use client";

import clsx from "clsx";
import { LoaderCircleIcon } from "lucide-react";

interface RecordingButtonProps {
	isRecording: boolean;
	isStarting?: boolean;
	disabled?: boolean;
	onStart: () => void;
	onStop: () => void;
}

export const RecordingButton = ({
	isRecording,
	isStarting = false,
	disabled = false,
	onStart,
	onStop,
}: RecordingButtonProps) => (
	<button
		type="button"
		disabled={disabled}
		onClick={isRecording ? onStop : onStart}
		className={clsx(
			"group flex h-12 w-full items-center justify-center gap-2.5 rounded-xl text-[0.9375rem] font-semibold text-white transition-[filter,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-2 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
			isRecording
				? "bg-gray-12 text-gray-1 hover:brightness-110"
				: "bg-gradient-to-b from-[#5b92ff] to-[#3a76f5] shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_6px_16px_-8px_rgba(58,118,245,0.8)] hover:brightness-105",
		)}
	>
		{isStarting ? (
			<LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
		) : isRecording ? (
			<span className="size-3 rounded-[3px] bg-[#ff4d4d]" aria-hidden />
		) : (
			<span
				className="relative flex size-3.5 items-center justify-center"
				aria-hidden
			>
				<span className="absolute inset-0 rounded-full bg-[#ff5a5a] opacity-60 group-hover:animate-ping motion-reduce:animate-none" />
				<span className="relative size-3.5 rounded-full bg-[#ff4d4d] ring-2 ring-white/70" />
			</span>
		)}
		{isStarting
			? "Waiting for your browser"
			: isRecording
				? "Stop recording"
				: "Start recording"}
	</button>
);

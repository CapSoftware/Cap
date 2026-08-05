"use client";

import { useEffect, useRef, useState } from "react";
import { formatClock } from "../timeline-format";
import { useVoiceRecorder, type VoiceRecording } from "./useVoiceRecorder";

const METER_BARS = 48;

/**
 * WhatsApp-style recording bar: pulsing dot, timer, live level bars, trash to
 * cancel, arrow to stop-and-send. Recording starts the moment it mounts — the
 * click that opened it is the one gesture, the permission prompt follows.
 */
export function VoiceRecorderBar({
	timestamp,
	onFinish,
	onCancel,
}: {
	timestamp: number;
	onFinish: (recording: VoiceRecording) => void;
	onCancel: () => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const levelsRef = useRef<number[]>([]);
	const [started, setStarted] = useState(false);

	const { phase, durationMs, start, stop, cancel } = useVoiceRecorder({
		onFinish,
		onLevel: (level) => {
			const levels = levelsRef.current;
			levels.push(level);
			if (levels.length > METER_BARS) levels.shift();
			const canvas = canvasRef.current;
			const context = canvas?.getContext("2d");
			if (!canvas || !context) return;
			context.clearRect(0, 0, canvas.width, canvas.height);
			const mid = canvas.height / 2;
			context.fillStyle = "#1696e0";
			for (let index = 0; index < levels.length; index += 1) {
				const height = Math.max(2, (levels[index] ?? 0) * canvas.height);
				context.beginPath();
				context.roundRect(index * 4, mid - height / 2, 2, height, 1);
				context.fill();
			}
		},
	});

	useEffect(() => {
		if (!started) {
			setStarted(true);
			void start();
		}
	}, [start, started]);

	const handleCancel = () => {
		cancel();
		onCancel();
	};

	return (
		<div className="new-card-style flex items-center gap-3 p-2.5">
			<span className="flex items-center gap-2">
				<span className="relative flex size-2.5">
					<span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
					<span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
				</span>
				<span className="font-mono text-xs tabular-nums text-gray-12">
					{formatClock(durationMs / 1000)}
				</span>
			</span>

			{phase === "denied" ? (
				<span className="text-xs text-gray-10">
					Microphone blocked — enable it in your browser
				</span>
			) : (
				<canvas
					ref={canvasRef}
					width={METER_BARS * 4}
					height={22}
					className="h-[22px]"
					aria-hidden
				/>
			)}

			<span className="rounded-md bg-gray-2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-gray-11 ring-1 ring-gray-4">
				{formatClock(timestamp)}
			</span>

			<button
				type="button"
				onClick={handleCancel}
				aria-label="Discard voice note"
				className="flex size-8 items-center justify-center rounded-lg text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12"
			>
				<svg
					viewBox="0 0 16 16"
					className="size-3.5"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.4"
					strokeLinecap="round"
					aria-hidden="true"
				>
					<path d="M3 4.5h10M6.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" />
				</svg>
			</button>
			<button
				type="button"
				onClick={stop}
				disabled={phase !== "recording"}
				aria-label="Send voice note"
				className="grid size-8 place-items-center rounded-full bg-blue-9 text-white transition-opacity hover:opacity-90 disabled:opacity-40"
			>
				<svg
					viewBox="0 0 16 16"
					className="size-4"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.6"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M8 12.5v-9M4 7l4-3.5L12 7" />
				</svg>
			</button>
		</div>
	);
}

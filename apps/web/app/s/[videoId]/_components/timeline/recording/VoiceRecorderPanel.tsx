"use client";

import { useRef } from "react";
import { formatClock } from "../timeline-format";
import { DevicePill } from "./DevicePill";
import { PauseResumeButton } from "./PauseResumeButton";
import { useCommentMediaDevices } from "./useCommentMediaDevices";
import { useVoiceRecorder, type VoiceRecording } from "./useVoiceRecorder";

const METER_BARS = 56;

/**
 * Voice replies in the same card family as screen and camera: a setup stage
 * (pick your mic, then an explicit Start — recording never begins on mount),
 * morphing in place into the recording stage with the live level meter,
 * pause/resume, restart-from-zero, and Discard/Send. One recorder instance
 * spans both stages; the mixer keeps the mic switchable mid-take.
 */
export function VoiceRecorderPanel({
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
	const devices = useCommentMediaDevices();

	const {
		phase,
		durationMs,
		start,
		stop,
		pause,
		resume,
		restart,
		switchMic,
		cancel,
	} = useVoiceRecorder({
		onFinish,
		selectedMicId: devices.selectedMicId,
		onMicInUse: devices.adoptMic,
		onDevicesChanged: devices.refreshDevices,
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

	const live = phase === "recording" || phase === "paused";
	const paused = phase === "paused";

	const handleCancel = () => {
		cancel();
		onCancel();
	};

	const handleRestart = () => {
		levelsRef.current = [];
		const canvas = canvasRef.current;
		canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
		restart();
	};

	const handleMicSelect = (deviceId: string) => {
		devices.selectMic(deviceId);
		if (live) void switchMic(deviceId);
	};

	return (
		<div className="new-card-style flex w-80 flex-col gap-2 p-2.5">
			{live || phase === "processing" ? (
				<div className="flex items-center justify-center gap-2.5 rounded-xl bg-gray-3 px-4 py-4">
					<span className="relative flex size-2.5 shrink-0">
						{phase === "recording" && (
							<span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
						)}
						<span
							className={`relative inline-flex size-2.5 rounded-full ${
								paused ? "bg-gray-8" : "bg-red-500"
							}`}
						/>
					</span>
					<span className="font-mono text-sm tabular-nums text-gray-12">
						{formatClock(durationMs / 1000)}
					</span>
					<canvas
						ref={canvasRef}
						width={METER_BARS * 4}
						height={24}
						className="h-6 min-w-0"
						aria-hidden
					/>
				</div>
			) : (
				<div className="flex flex-col items-center gap-2.5 rounded-xl bg-gray-3 px-5 py-5 text-center">
					<span className="grid size-9 place-items-center rounded-full bg-white text-gray-11 ring-1 ring-gray-5">
						<svg
							viewBox="0 0 16 16"
							className="size-4 fill-current"
							aria-hidden
						>
							<title>Voice</title>
							<path d="M8 2a2 2 0 0 0-2 2v4a2 2 0 1 0 4 0V4a2 2 0 0 0-2-2ZM4.4 7.4a.6.6 0 0 0-1.2 0 4.8 4.8 0 0 0 4.2 4.76V13.4H5.8a.6.6 0 1 0 0 1.2h4.4a.6.6 0 1 0 0-1.2H8.6v-1.24a4.8 4.8 0 0 0 4.2-4.76.6.6 0 1 0-1.2 0 3.6 3.6 0 1 1-7.2 0Z" />
						</svg>
					</span>
					<p className="text-xs leading-relaxed text-gray-11">
						{phase === "denied"
							? "Microphone is blocked. Enable it in your browser settings, then try again."
							: phase === "requesting"
								? "Waiting for microphone access…"
								: devices.mics.length > 0
									? "Pick a microphone, then click Start to record your voice note."
									: "Click Start and your browser will ask for microphone access."}
					</p>
				</div>
			)}

			{devices.mics.length > (live ? 1 : 0) && (
				<DevicePill
					kind="mic"
					devices={devices.mics}
					selectedId={devices.selectedMicId}
					onSelect={handleMicSelect}
					disabled={phase === "processing" || phase === "requesting"}
					className="w-full min-w-0"
				/>
			)}

			<div className="flex items-center gap-1.5">
				{/* 0 = the viewer wasn't at a moment in the video; no stamp to show. */}
				{timestamp > 0 && (
					<span className="rounded-md bg-gray-2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-gray-11 ring-1 ring-gray-4">
						{formatClock(timestamp)}
					</span>
				)}

				{live && (
					<>
						<PauseResumeButton
							paused={paused}
							onToggle={paused ? resume : pause}
							shape="square"
						/>
						<button
							type="button"
							onClick={handleRestart}
							aria-label="Restart recording"
							title="Start the take over"
							className="h-7 rounded-lg px-2.5 text-xs text-gray-10 ring-1 ring-gray-4 transition-colors hover:bg-gray-2 hover:text-gray-12"
						>
							Restart
						</button>
					</>
				)}

				<div className="flex-1" />

				{live || phase === "processing" ? (
					<>
						<button
							type="button"
							onClick={handleCancel}
							disabled={phase === "processing"}
							aria-label="Discard voice note"
							className="h-7 rounded-lg px-2.5 text-xs text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12 disabled:opacity-40"
						>
							Discard
						</button>
						<button
							type="button"
							onClick={() => void stop()}
							disabled={phase === "processing"}
							aria-label="Send voice note"
							className="h-7 rounded-lg bg-blue-9 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
						>
							Send
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							onClick={handleCancel}
							className="h-7 rounded-lg px-2.5 text-xs text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => void start()}
							disabled={phase === "requesting"}
							className="h-7 rounded-lg bg-blue-9 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
						>
							{phase === "denied" ? "Try again" : "Start"}
						</button>
					</>
				)}
			</div>
		</div>
	);
}

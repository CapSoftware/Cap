"use client";

import { formatClock } from "../timeline-format";
import { DevicePill } from "./DevicePill";
import { MicMuteButton } from "./MicMuteButton";
import { PauseResumeButton } from "./PauseResumeButton";
import { useCommentMediaDevices } from "./useCommentMediaDevices";
import {
	type CommentRecording,
	useCommentRecorder,
} from "./useCommentRecorder";

/**
 * The whole screen-reply flow in ONE card, same anatomy as the camera panel:
 * a setup stage (mic choice, what happens next), then the same card morphs
 * into the recording stage (timer, live mic switch, pause, stop) in place.
 * No separate floating bar — the card is the surface for the entire take.
 *
 * The share picker launches from the Next click itself, so there is no
 * auto-start effect and nothing for StrictMode to double-fire. Cancelling
 * the picker just returns to setup. One recorder instance spans both stages,
 * so the mute chosen during setup is simply the same state the recording
 * reads; the browser's own "Stop sharing" still ends the take normally.
 */
export function ScreenRecorderPanel({
	timestamp,
	onFinish,
	onCancel,
}: {
	timestamp: number;
	onFinish: (recording: CommentRecording) => void;
	onCancel: () => void;
}) {
	const devices = useCommentMediaDevices();
	const {
		phase,
		durationMs,
		micMuted,
		liveMicSwitchable,
		error,
		startScreen,
		switchMic,
		toggleMic,
		pause,
		resume,
		stop,
		cancel,
	} = useCommentRecorder({
		onFinish,
		// Picker dismissed: phase returns to idle and the setup stage is still
		// on screen — the natural "try again" spot, so no surface teardown.
		selectedCameraId: null,
		selectedMicId: devices.selectedMicId,
		onMicInUse: devices.adoptMic,
		onDevicesChanged: devices.refreshDevices,
	});

	const live = phase === "recording" || phase === "paused";
	const paused = phase === "paused";

	const handleCancel = () => {
		cancel();
		onCancel();
	};

	const handleMicSelect = (deviceId: string) => {
		devices.selectMic(deviceId);
		if (live) void switchMic(deviceId);
	};

	return (
		<div className="new-card-style flex w-80 flex-col gap-2 p-2.5">
			{live || phase === "processing" ? (
				<div className="flex items-center justify-center gap-2.5 rounded-xl bg-gray-3 px-5 py-4">
					<span className="relative flex size-2.5 shrink-0">
						{!paused && (
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
					<span className="text-xs text-gray-10">
						{paused ? "Paused" : "Recording your screen"}
					</span>
				</div>
			) : (
				<div className="flex flex-col items-center gap-2.5 rounded-xl bg-gray-3 px-5 py-5 text-center">
					<span className="grid size-9 place-items-center rounded-full bg-white text-gray-11 ring-1 ring-gray-5">
						<svg
							viewBox="0 0 16 16"
							className="size-4 fill-current"
							aria-hidden
						>
							<title>Screen</title>
							<path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Zm3.2 9.4h5.6a.6.6 0 1 1 0 1.2H5.2a.6.6 0 1 1 0-1.2Z" />
						</svg>
					</span>
					<p className="text-xs leading-relaxed text-gray-11">
						{error
							? error
							: phase === "requesting"
								? "Waiting for your browser's share picker…"
								: devices.mics.length > 0
									? "Pick a microphone, then click Next. Your browser will ask which screen, window, or tab to share, and recording starts right away."
									: "Click Next and your browser will ask which screen, window, or tab to share. Recording starts right away."}
					</p>
				</div>
			)}

			{devices.mics.length > (live ? 1 : 0) && (
				<DevicePill
					kind="mic"
					devices={devices.mics}
					selectedId={devices.selectedMicId}
					onSelect={handleMicSelect}
					disabled={
						phase === "processing" ||
						(live && !liveMicSwitchable) ||
						(!live && micMuted)
					}
					title={
						live && !liveMicSwitchable
							? "This recording has no microphone track"
							: !live && micMuted
								? "Microphone is off for this recording"
								: undefined
					}
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

				<MicMuteButton muted={micMuted} onToggle={toggleMic} shape="square" />

				{live && (
					<PauseResumeButton
						paused={paused}
						onToggle={paused ? resume : pause}
						shape="square"
					/>
				)}

				<div className="flex-1" />

				{live || phase === "processing" ? (
					<>
						<button
							type="button"
							onClick={handleCancel}
							disabled={phase === "processing"}
							className="h-7 rounded-lg px-2.5 text-xs text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12 disabled:opacity-40"
						>
							Discard
						</button>
						<button
							type="button"
							onClick={() => void stop()}
							disabled={phase === "processing"}
							className="flex h-7 items-center gap-1.5 rounded-lg bg-gray-12 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
						>
							<span className="inline-flex size-2 rounded-sm bg-red-400" />
							Stop
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
							onClick={() => void startScreen()}
							disabled={phase === "requesting"}
							className="h-7 rounded-lg bg-blue-9 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
						>
							{error ? "Try again" : "Next"}
						</button>
					</>
				)}
			</div>
		</div>
	);
}

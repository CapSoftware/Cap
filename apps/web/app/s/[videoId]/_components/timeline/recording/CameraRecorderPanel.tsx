"use client";

import { useEffect, useRef } from "react";
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
 * Inline camera reply: mirrored live preview, camera/mic pickers backed by the
 * shared web recorder engine, Start → timer → Stop. Mic is on by default
 * (mutable), and stays switchable even mid-recording; the camera locks while
 * recording because its track feeds the encoder directly.
 */
export function CameraRecorderPanel({
	timestamp,
	onFinish,
	onCancel,
}: {
	timestamp: number;
	onFinish: (recording: CommentRecording) => void;
	onCancel: () => void;
}) {
	const previewRef = useRef<HTMLVideoElement | null>(null);
	const devices = useCommentMediaDevices();

	const {
		phase,
		durationMs,
		micMuted,
		previewStream,
		switchingCamera,
		liveMicSwitchable,
		error,
		openCamera,
		switchCamera,
		switchMic,
		startCameraRecording,
		toggleMic,
		pause,
		resume,
		stop,
		cancel,
	} = useCommentRecorder({
		onFinish,
		onPickerCancelled: onCancel,
		selectedCameraId: devices.selectedCameraId,
		selectedMicId: devices.selectedMicId,
		onCameraInUse: devices.adoptCamera,
		onMicInUse: devices.adoptMic,
		onDevicesChanged: devices.refreshDevices,
	});

	// Cancellable-timeout auto-start: survives StrictMode's mount → cancel →
	// remount cycle with exactly one getUserMedia.
	const openRef = useRef(openCamera);
	openRef.current = openCamera;
	useEffect(() => {
		const id = window.setTimeout(() => void openRef.current(), 0);
		return () => window.clearTimeout(id);
	}, []);

	useEffect(() => {
		if (previewRef.current && previewStream)
			previewRef.current.srcObject = previewStream;
	}, [previewStream]);

	const handleCancel = () => {
		cancel();
		onCancel();
	};

	const handleCameraSelect = (deviceId: string) => {
		devices.selectCamera(deviceId);
		void switchCamera(deviceId);
	};

	const handleMicSelect = (deviceId: string) => {
		devices.selectMic(deviceId);
		void switchMic(deviceId);
	};

	const live = phase === "recording" || phase === "paused";
	const micSwitchable = phase === "ready" || (live && liveMicSwitchable);

	return (
		<div className="new-card-style flex w-80 flex-col gap-2 p-2.5">
			<div className="relative aspect-video w-full overflow-hidden rounded-xl bg-gray-3">
				{error ? (
					<div className="grid size-full place-items-center px-6 text-center text-xs text-gray-10">
						{error}
					</div>
				) : (
					<video
						ref={previewRef}
						autoPlay
						muted
						playsInline
						className="size-full -scale-x-100 object-cover"
					/>
				)}
				{switchingCamera && (
					<div className="absolute inset-0 grid place-items-center bg-gray-3/60">
						<span className="size-5 animate-spin rounded-full border-2 border-gray-8 border-t-transparent" />
					</div>
				)}
				{live && (
					<span className="absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] tabular-nums text-white backdrop-blur-md">
						<span
							className={`inline-flex size-2 rounded-full ${
								phase === "paused" ? "bg-gray-8" : "bg-red-500"
							}`}
						/>
						{formatClock(durationMs / 1000)}
						{phase === "paused" && (
							<span className="text-white/70">Paused</span>
						)}
					</span>
				)}
			</div>

			{(devices.cameras.length > 1 || devices.mics.length > 1) && (
				<div className="flex items-center gap-1.5">
					{devices.cameras.length > 1 && (
						<DevicePill
							kind="camera"
							devices={devices.cameras}
							selectedId={devices.selectedCameraId}
							onSelect={handleCameraSelect}
							disabled={phase !== "ready" || switchingCamera}
							title={live ? "Stop recording to switch cameras" : undefined}
							className="min-w-0 flex-1"
						/>
					)}
					{devices.mics.length > 1 && (
						<DevicePill
							kind="mic"
							devices={devices.mics}
							selectedId={devices.selectedMicId}
							onSelect={handleMicSelect}
							disabled={!micSwitchable}
							className="min-w-0 flex-1"
						/>
					)}
				</div>
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
						paused={phase === "paused"}
						onToggle={phase === "paused" ? resume : pause}
						shape="square"
					/>
				)}

				<div className="flex-1" />

				<button
					type="button"
					onClick={handleCancel}
					className="h-7 rounded-lg px-2.5 text-xs text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12"
				>
					Cancel
				</button>
				{live ? (
					<button
						type="button"
						onClick={() => void stop()}
						className="flex h-7 items-center gap-1.5 rounded-lg bg-gray-12 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90"
					>
						<span className="inline-flex size-2 rounded-sm bg-red-400" />
						Stop
					</button>
				) : (
					<button
						type="button"
						onClick={() => void startCameraRecording()}
						disabled={phase !== "ready" || switchingCamera}
						className="h-7 rounded-lg bg-blue-9 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
					>
						Start
					</button>
				)}
			</div>
		</div>
	);
}

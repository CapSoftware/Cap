"use client";

import { useEffect, useRef, useState } from "react";
import { useCameraDevices } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useCameraDevices";
import { formatClock } from "../timeline-format";
import {
	type CommentRecording,
	useCommentRecorder,
} from "./useCommentRecorder";

/**
 * Inline camera reply: mirrored live preview, device picker only when there's
 * a choice, Start → timer → Stop. Mic is on by default (mutable).
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
	const [opened, setOpened] = useState(false);
	const { devices: cameras } = useCameraDevices(true);

	const {
		phase,
		durationMs,
		micMuted,
		previewStream,
		error,
		openCamera,
		startCameraRecording,
		toggleMic,
		stop,
		cancel,
	} = useCommentRecorder({ onFinish, onPickerCancelled: onCancel });

	useEffect(() => {
		if (!opened) {
			setOpened(true);
			void openCamera();
		}
	}, [openCamera, opened]);

	useEffect(() => {
		if (previewRef.current && previewStream)
			previewRef.current.srcObject = previewStream;
	}, [previewStream]);

	const handleCancel = () => {
		cancel();
		onCancel();
	};

	const switchCamera = (deviceId: string) => {
		cancel();
		void openCamera({ camera: deviceId });
	};

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
				{phase === "recording" && (
					<span className="absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] tabular-nums text-white backdrop-blur-md">
						<span className="inline-flex size-2 rounded-full bg-red-500" />
						{formatClock(durationMs / 1000)}
					</span>
				)}
			</div>

			<div className="flex items-center gap-1.5">
				<span className="rounded-md bg-gray-2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-gray-11 ring-1 ring-gray-4">
					{formatClock(timestamp)}
				</span>

				{cameras.length > 1 && phase === "ready" && (
					<select
						aria-label="Camera"
						onChange={(event) => switchCamera(event.target.value)}
						className="h-7 max-w-28 truncate rounded-lg bg-gray-2 px-1.5 text-[11px] text-gray-11 ring-1 ring-gray-4 outline-none"
					>
						{cameras.map((camera) => (
							<option key={camera.deviceId} value={camera.deviceId}>
								{camera.label || "Camera"}
							</option>
						))}
					</select>
				)}

				<button
					type="button"
					onClick={toggleMic}
					aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
					aria-pressed={micMuted}
					className={`flex size-7 items-center justify-center rounded-lg ring-1 ring-gray-4 transition-colors ${
						micMuted ? "bg-gray-3 text-gray-9" : "bg-gray-2 text-gray-12"
					}`}
				>
					<svg
						viewBox="0 0 16 16"
						className="size-3.5"
						fill="currentColor"
						aria-hidden="true"
					>
						<path d="M8 1.5A2.25 2.25 0 0 0 5.75 3.75v3.5a2.25 2.25 0 0 0 4.5 0v-3.5A2.25 2.25 0 0 0 8 1.5Z" />
						<path d="M3.75 6.75a.65.65 0 0 1 1.3 0v.5a2.95 2.95 0 0 0 5.9 0v-.5a.65.65 0 0 1 1.3 0v.5a4.25 4.25 0 0 1-3.6 4.2v1.55h1.6a.65.65 0 0 1 0 1.3h-4.5a.65.65 0 0 1 0-1.3h1.6v-1.55a4.25 4.25 0 0 1-3.6-4.2v-.5Z" />
						{micMuted && (
							<path
								d="M2 2l12 12"
								stroke="currentColor"
								strokeWidth="1.4"
								strokeLinecap="round"
							/>
						)}
					</svg>
				</button>

				<div className="flex-1" />

				<button
					type="button"
					onClick={handleCancel}
					className="h-7 rounded-lg px-2.5 text-xs text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12"
				>
					Cancel
				</button>
				{phase === "recording" ? (
					<button
						type="button"
						onClick={stop}
						className="flex h-7 items-center gap-1.5 rounded-lg bg-gray-12 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90"
					>
						<span className="inline-flex size-2 rounded-sm bg-red-400" />
						Stop
					</button>
				) : (
					<button
						type="button"
						onClick={startCameraRecording}
						disabled={phase !== "ready"}
						className="h-7 rounded-lg bg-blue-9 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
					>
						Start
					</button>
				)}
			</div>
		</div>
	);
}

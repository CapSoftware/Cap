"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	type EditorClipCapture,
	type EditorClipCaptureSession,
	startEditorClipCapture,
} from "@/lib/editor-clip-recorder";

type Phase =
	| "idle"
	| "starting"
	| "recording"
	| "paused"
	| "uploading"
	| "error";

function elapsedLabel(milliseconds: number) {
	const seconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(seconds / 60);
	return `${minutes.toString().padStart(2, "0")}:${(seconds % 60)
		.toString()
		.padStart(2, "0")}`;
}

export function EditorClipRecorder(props: {
	onCaptured: (clip: EditorClipCapture) => Promise<void>;
	onClose: (imported: boolean) => void;
}) {
	const titleId = useId();
	const [cameraEnabled, setCameraEnabled] = useState(true);
	const [micEnabled, setMicEnabled] = useState(true);
	const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [elapsedMs, setElapsedMs] = useState(0);
	const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
	const [captured, setCaptured] = useState<EditorClipCapture | null>(null);
	const [capturedCanImport, setCapturedCanImport] = useState(false);
	const [downloadUrls, setDownloadUrls] = useState<{
		display: string;
		camera: string | null;
	} | null>(null);
	const sessionRef = useRef<EditorClipCaptureSession | null>(null);
	const previewRef = useRef<HTMLVideoElement>(null);
	const stopRef = useRef<() => Promise<void>>(async () => undefined);
	const stoppingRef = useRef(false);
	const startedAtRef = useRef(0);
	const pausedAtRef = useRef<number | null>(null);
	const pausedTotalRef = useRef(0);

	useEffect(() => {
		if (!previewRef.current) return;
		previewRef.current.srcObject = previewStream;
		return () => {
			if (previewRef.current) previewRef.current.srcObject = null;
		};
	}, [previewStream]);

	useEffect(() => {
		if (phase !== "recording" && phase !== "paused") return;
		const timer = window.setInterval(() => {
			const now = pausedAtRef.current ?? performance.now();
			setElapsedMs(
				Math.max(0, now - startedAtRef.current - pausedTotalRef.current),
			);
		}, 200);
		return () => window.clearInterval(timer);
	}, [phase]);

	useEffect(() => {
		if (!captured) {
			setDownloadUrls(null);
			return;
		}
		const display = URL.createObjectURL(captured.display);
		const camera = captured.camera
			? URL.createObjectURL(captured.camera)
			: null;
		setDownloadUrls({ display, camera });
		return () => {
			URL.revokeObjectURL(display);
			if (camera) URL.revokeObjectURL(camera);
		};
	}, [captured]);

	useEffect(
		() => () => {
			void sessionRef.current?.stop().catch(() => undefined);
		},
		[],
	);

	const importCapture = useCallback(
		async (clip: EditorClipCapture) => {
			setPhase("uploading");
			setError(null);
			try {
				await props.onCaptured(clip);
				await sessionRef.current?.release().catch(() => undefined);
				sessionRef.current = null;
				props.onClose(true);
			} catch (cause) {
				setError(
					cause instanceof Error ? cause.message : "Could not add the clip",
				);
				setCapturedCanImport(true);
				setPhase("error");
			}
		},
		[props],
	);

	const handleStop = useCallback(async () => {
		if (stoppingRef.current || !sessionRef.current) return;
		stoppingRef.current = true;
		setPhase("uploading");
		try {
			const clip = await sessionRef.current.stop();
			setPreviewStream(null);
			setCaptured(clip);
			setCapturedCanImport(true);
			await importCapture(clip);
		} catch (cause) {
			setPreviewStream(null);
			const recovered = await sessionRef.current.recover().catch(() => null);
			setCaptured(recovered);
			setCapturedCanImport(false);
			setError(
				cause instanceof Error ? cause.message : "Could not finish the clip",
			);
			setPhase("error");
		} finally {
			stoppingRef.current = false;
		}
	}, [importCapture]);
	stopRef.current = handleStop;

	const handleStart = async () => {
		if (phase !== "idle" && phase !== "error") return;
		if (sessionRef.current) {
			await sessionRef.current.discard().catch(() => undefined);
			sessionRef.current = null;
		}
		setCaptured(null);
		setCapturedCanImport(false);
		setError(null);
		setPhase("starting");
		try {
			const session = await startEditorClipCapture({
				cameraEnabled,
				micEnabled,
				systemAudioEnabled,
				onDisplayEnded: () => void stopRef.current(),
				onError: (cause) => {
					setError(cause.message);
					void stopRef.current();
				},
			});
			sessionRef.current = session;
			setPreviewStream(session.cameraPreviewStream);
			startedAtRef.current = performance.now();
			pausedAtRef.current = null;
			pausedTotalRef.current = 0;
			setElapsedMs(0);
			setPhase("recording");
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not start recording",
			);
			setPhase("error");
		}
	};

	const handlePause = () => {
		if (phase !== "recording") return;
		sessionRef.current?.pause();
		pausedAtRef.current = performance.now();
		setPhase("paused");
	};

	const handleResume = () => {
		if (phase !== "paused") return;
		sessionRef.current?.resume();
		pausedTotalRef.current += performance.now() - (pausedAtRef.current ?? 0);
		pausedAtRef.current = null;
		setPhase("recording");
	};

	const handleDiscard = async () => {
		if (phase === "uploading" || phase === "starting") return;
		await sessionRef.current?.discard();
		sessionRef.current = null;
		props.onClose(false);
	};

	return (
		<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-5">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				className="w-full max-w-[460px] rounded-2xl border border-white/15 bg-[#181818] p-6 text-white shadow-2xl"
			>
				<div className="flex items-start justify-between gap-4">
					<div>
						<h2 id={titleId} className="text-lg font-semibold">
							Record New Clip
						</h2>
						<p className="mt-1 text-sm text-white/60">
							Add another screen recording to this project.
						</p>
					</div>
					{phase !== "starting" && phase !== "uploading" && (
						<button
							type="button"
							aria-label="Discard clip and close recorder"
							className="rounded-md px-2 py-1 text-white/60 hover:bg-white/10 hover:text-white"
							onClick={() => void handleDiscard()}
						>
							×
						</button>
					)}
				</div>
				{phase === "idle" || (phase === "error" && !captured) ? (
					<div className="mt-6 flex flex-col gap-3 text-sm">
						<label className="flex items-center justify-between gap-4">
							<span>Camera</span>
							<input
								type="checkbox"
								checked={cameraEnabled}
								onChange={(event) => setCameraEnabled(event.target.checked)}
							/>
						</label>
						<label className="flex items-center justify-between gap-4">
							<span>Microphone</span>
							<input
								type="checkbox"
								checked={micEnabled}
								onChange={(event) => setMicEnabled(event.target.checked)}
							/>
						</label>
						<label className="flex items-center justify-between gap-4">
							<span>Screen audio</span>
							<input
								type="checkbox"
								checked={systemAudioEnabled}
								onChange={(event) =>
									setSystemAudioEnabled(event.target.checked)
								}
							/>
						</label>
					</div>
				) : null}
				{previewStream && (
					<video
						ref={previewRef}
						autoPlay
						muted
						playsInline
						aria-label="Live camera preview"
						className="mt-5 aspect-video w-full rounded-xl bg-black object-cover"
					/>
				)}
				{phase === "recording" || phase === "paused" ? (
					<div className="mt-5 flex items-center justify-between rounded-lg bg-white/10 px-4 py-3">
						<span className="text-sm">
							{phase === "paused" ? "Paused" : "Recording"}
						</span>
						<time className="font-mono text-sm tabular-nums">
							{elapsedLabel(elapsedMs)}
						</time>
					</div>
				) : null}
				{phase === "starting" && (
					<p className="mt-6 text-sm text-white/70">Opening screen picker…</p>
				)}
				{phase === "uploading" && (
					<p className="mt-6 text-sm text-white/70">Adding clip to editor…</p>
				)}
				{error && (
					<p
						role="alert"
						className="mt-5 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200"
					>
						{error}
					</p>
				)}
				{captured && downloadUrls && phase === "error" && (
					<div className="mt-4 flex gap-4 text-sm text-blue-300">
						<a href={downloadUrls.display} download={captured.display.name}>
							Download screen clip
						</a>
						{captured.camera && downloadUrls.camera && (
							<a href={downloadUrls.camera} download={captured.camera.name}>
								Download camera clip
							</a>
						)}
					</div>
				)}
				<div className="mt-6 flex justify-end gap-3">
					{phase === "idle" || (phase === "error" && !captured) ? (
						<button
							type="button"
							className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500"
							onClick={() => void handleStart()}
						>
							Start recording
						</button>
					) : null}
					{phase === "recording" && (
						<button
							type="button"
							className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
							onClick={handlePause}
						>
							Pause
						</button>
					)}
					{phase === "paused" && (
						<button
							type="button"
							className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
							onClick={handleResume}
						>
							Resume
						</button>
					)}
					{(phase === "recording" || phase === "paused") && (
						<button
							type="button"
							className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium hover:bg-red-500"
							onClick={() => void handleStop()}
						>
							Stop and add clip
						</button>
					)}
					{phase === "error" && captured && capturedCanImport && (
						<button
							type="button"
							className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500"
							onClick={() => void importCapture(captured)}
						>
							Retry import
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

"use client";

import { isUserCancellationError } from "@cap/recorder-core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	CAMERA_CONSTRAINTS,
	DISPLAY_CONSTRAINTS,
	MIC_CONSTRAINTS,
	pickVideoMime,
} from "./recorder-constraints";

export type CommentRecorderMode = "camera" | "screen";

export type CommentRecorderPhase =
	| "idle"
	| "requesting"
	| "ready" // camera only: live preview, not yet recording
	| "recording"
	| "processing";

export interface CommentRecording {
	blob: Blob;
	mime: string;
	durationSeconds: number;
	width?: number;
	height?: number;
	hasAudio: boolean;
}

/**
 * Camera/screen recorder for video comments. Screen mode calls
 * `getDisplayMedia` immediately (the browser picker is the mode selector) and
 * mixes system audio with the mic through a limiter — the graph proven in the
 * dashboard web recorder. No duration cap (Pro feature).
 */
export function useCommentRecorder(options: {
	onFinish: (recording: CommentRecording) => void;
	/** User dismissed the browser's screen picker — treat as a silent cancel. */
	onPickerCancelled?: () => void;
}) {
	const [phase, setPhase] = useState<CommentRecorderPhase>("idle");
	const [durationMs, setDurationMs] = useState(0);
	const [micMuted, setMicMuted] = useState(false);
	const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
	const [error, setError] = useState<string | null>(null);

	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamsRef = useRef<MediaStream[]>([]);
	const mixedStreamRef = useRef<MediaStream | null>(null);
	const audioContextRef = useRef<AudioContext | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const startedAtRef = useRef(0);
	const tickRef = useRef(0);
	const discardRef = useRef(false);
	// Bumped by cancel/unmount so an acquisition suspended on a permission
	// prompt or picker knows its run was abandoned and stops the granted
	// tracks instead of recording into an unmounted component.
	const runIdRef = useRef(0);
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const abandoned = useCallback((runId: number, stream?: MediaStream) => {
		if (runId === runIdRef.current && !discardRef.current) return false;
		if (stream) for (const track of stream.getTracks()) track.stop();
		return true;
	}, []);

	const cleanup = useCallback(() => {
		if (tickRef.current) window.clearInterval(tickRef.current);
		tickRef.current = 0;
		for (const stream of streamsRef.current)
			for (const track of stream.getTracks()) track.stop();
		streamsRef.current = [];
		for (const track of mixedStreamRef.current?.getTracks() ?? []) track.stop();
		mixedStreamRef.current = null;
		void audioContextRef.current?.close().catch(() => {});
		audioContextRef.current = null;
		recorderRef.current = null;
		setPreviewStream(null);
	}, []);

	const beginRecording = useCallback(
		(stream: MediaStream) => {
			const mime = pickVideoMime();
			let recorder: MediaRecorder;
			try {
				recorder = new MediaRecorder(
					stream,
					mime ? { mimeType: mime } : undefined,
				);
			} catch {
				cleanup();
				setError("Recording isn't supported in this browser.");
				setPhase("idle");
				return;
			}
			recorderRef.current = recorder;
			chunksRef.current = [];

			recorder.addEventListener("dataavailable", (event) => {
				if (event.data.size > 0) chunksRef.current.push(event.data);
			});
			recorder.addEventListener("stop", () => {
				const elapsed = (performance.now() - startedAtRef.current) / 1000;
				const recordedMime = recorder.mimeType || mime || "video/webm";
				const blob = new Blob(chunksRef.current, { type: recordedMime });
				chunksRef.current = [];
				const settings = stream.getVideoTracks()[0]?.getSettings();
				const hasAudio = stream.getAudioTracks().length > 0;
				cleanup();

				if (discardRef.current || blob.size === 0) {
					setPhase("idle");
					setDurationMs(0);
					return;
				}
				setPhase("processing");
				optionsRef.current.onFinish({
					blob,
					mime: recordedMime,
					durationSeconds: elapsed,
					width: settings?.width,
					height: settings?.height,
					hasAudio,
				});
				setPhase("idle");
				setDurationMs(0);
			});

			// The browser's own "Stop sharing" bar ends the video track; treat it as
			// a normal stop.
			stream.getVideoTracks()[0]?.addEventListener("ended", () => {
				if (recorder.state === "recording") recorder.stop();
			});

			startedAtRef.current = performance.now();
			setDurationMs(0);
			tickRef.current = window.setInterval(() => {
				setDurationMs(performance.now() - startedAtRef.current);
			}, 500);
			recorder.start(1000);
			setPhase("recording");
		},
		[cleanup],
	);

	/** Camera: acquire devices and enter live preview; `startRecording` begins. */
	const openCamera = useCallback(
		async (deviceIds?: { camera?: string; microphone?: string }) => {
			setError(null);
			setPhase("requesting");
			discardRef.current = false;
			const runId = ++runIdRef.current;
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					video: {
						...CAMERA_CONSTRAINTS,
						...(deviceIds?.camera ? { deviceId: deviceIds.camera } : {}),
					},
					audio: {
						...MIC_CONSTRAINTS,
						...(deviceIds?.microphone
							? { deviceId: deviceIds.microphone }
							: {}),
					},
				});
				if (abandoned(runId, stream)) return;
				streamsRef.current = [stream];
				mixedStreamRef.current = stream;
				setPreviewStream(stream);
				setPhase("ready");
			} catch (cause) {
				cleanup();
				setPhase("idle");
				if (isUserCancellationError(cause)) {
					optionsRef.current.onPickerCancelled?.();
					return;
				}
				setError("Camera or microphone access was blocked.");
			}
		},
		[cleanup],
	);

	const startCameraRecording = useCallback(() => {
		const stream = mixedStreamRef.current;
		if (phase !== "ready" || !stream) return;
		beginRecording(stream);
	}, [beginRecording, phase]);

	/** Screen: picker immediately, then mic mix, then recording starts. */
	const startScreen = useCallback(async () => {
		setError(null);
		setPhase("requesting");
		discardRef.current = false;
		const runId = ++runIdRef.current;

		let displayStream: MediaStream;
		try {
			displayStream = await navigator.mediaDevices.getDisplayMedia(
				DISPLAY_CONSTRAINTS as MediaStreamConstraints,
			);
		} catch (cause) {
			if (isUserCancellationError(cause)) {
				if (runId === runIdRef.current) setPhase("idle");
				optionsRef.current.onPickerCancelled?.();
				return;
			}
			// Some setups reject the audio request outright; retry video-only.
			try {
				displayStream = await navigator.mediaDevices.getDisplayMedia({
					video: DISPLAY_CONSTRAINTS.video,
				});
			} catch (retryCause) {
				if (runId !== runIdRef.current) return;
				setPhase("idle");
				if (isUserCancellationError(retryCause)) {
					optionsRef.current.onPickerCancelled?.();
					return;
				}
				setError("Screen recording isn't available here.");
				return;
			}
		}
		if (abandoned(runId, displayStream)) return;
		streamsRef.current = [displayStream];

		let micStream: MediaStream | null = null;
		try {
			micStream = await navigator.mediaDevices.getUserMedia({
				audio: MIC_CONSTRAINTS,
			});
			if (abandoned(runId, micStream)) return;
			streamsRef.current.push(micStream);
		} catch {
			// No mic is fine; system audio (if granted) still records.
		}

		const systemAudioTracks = displayStream.getAudioTracks();
		let audioTracks: MediaStreamTrack[] = [];
		if (systemAudioTracks.length > 0 && micStream) {
			// System + mic mixed through a limiter — verbatim from the dashboard
			// recorder's proven graph.
			const audioCtx = new AudioContext();
			audioContextRef.current = audioCtx;
			if (audioCtx.state !== "running") await audioCtx.resume();
			const systemSource = audioCtx.createMediaStreamSource(
				new MediaStream(systemAudioTracks),
			);
			const micSource = audioCtx.createMediaStreamSource(micStream);
			const destination = audioCtx.createMediaStreamDestination();
			const limiter = audioCtx.createDynamicsCompressor();
			limiter.threshold.value = -3;
			limiter.knee.value = 2;
			limiter.ratio.value = 20;
			limiter.attack.value = 0.002;
			limiter.release.value = 0.05;
			systemSource.connect(limiter);
			micSource.connect(limiter);
			limiter.connect(destination);
			audioTracks = destination.stream.getAudioTracks();
		} else if (systemAudioTracks.length > 0) {
			audioTracks = systemAudioTracks;
		} else if (micStream) {
			audioTracks = micStream.getAudioTracks();
		}

		const mixed = new MediaStream([
			...displayStream.getVideoTracks(),
			...audioTracks,
		]);
		mixedStreamRef.current = mixed;
		beginRecording(mixed);
	}, [beginRecording]);

	const toggleMic = useCallback(() => {
		setMicMuted((muted) => {
			const next = !muted;
			for (const stream of streamsRef.current)
				for (const track of stream.getAudioTracks()) track.enabled = !next;
			return next;
		});
	}, []);

	const stop = useCallback(() => {
		if (recorderRef.current?.state === "recording") recorderRef.current.stop();
	}, []);

	const cancel = useCallback(() => {
		discardRef.current = true;
		runIdRef.current += 1;
		if (recorderRef.current?.state === "recording") {
			recorderRef.current.stop();
		} else {
			cleanup();
			setPhase("idle");
			setDurationMs(0);
		}
	}, [cleanup]);

	useEffect(
		() => () => {
			discardRef.current = true;
			runIdRef.current += 1;
			if (recorderRef.current?.state === "recording")
				recorderRef.current.stop();
			cleanup();
		},
		[cleanup],
	);

	return {
		phase,
		durationMs,
		micMuted,
		previewStream,
		error,
		openCamera,
		startCameraRecording,
		startScreen,
		toggleMic,
		stop,
		cancel,
	};
}

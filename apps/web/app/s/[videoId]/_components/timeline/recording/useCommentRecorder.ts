"use client";

import {
	type AudioMixer,
	acquireCameraStream,
	acquireCameraWithMicStream,
	acquireDisplayStream,
	acquireMicStream,
	createAudioMixer,
	getCaptureErrorMessage,
} from "@cap/recorder-core/capture-streams";
import {
	isUserCancellationError,
	selectRecordingPipelineFromSupport,
} from "@cap/recorder-core/recorder-utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaRecorderSetup } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useMediaRecorderSetup";
import { useRecordingTimer } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useRecordingTimer";

export type CommentRecorderMode = "camera" | "screen";

export type CommentRecorderPhase =
	| "idle"
	| "requesting"
	| "ready" // camera only: live preview, not yet recording
	| "recording"
	| "paused"
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
 * The web recorder's pipeline selector with streaming upload off: comment
 * media uploads once at the end and plays back directly (iOS included), so
 * mp4 (H.264/AAC) beats webm whenever the browser can record it.
 */
const selectCommentVideoPipeline = (hasAudio: boolean) => {
	if (typeof MediaRecorder === "undefined") return null;
	return selectRecordingPipelineFromSupport(
		hasAudio,
		(candidate) => {
			try {
				return MediaRecorder.isTypeSupported(candidate);
			} catch {
				return false;
			}
		},
		{ preferStreamingUpload: false },
	);
};

/**
 * Camera/screen recorder for video comments, built on the same capture engine
 * as the dashboard web recorder (`@cap/recorder-core/capture-streams`).
 *
 * - Camera and mic are held as separate streams so either device can be
 *   swapped without touching the other; the initial grab is one combined
 *   getUserMedia call so the user sees a single permission prompt.
 * - Recording audio always routes through the engine's mixer node, whose
 *   output track identity never changes — that is what makes live mic
 *   switching work even mid-recording.
 * - Screen mode calls getDisplayMedia immediately (the browser picker is the
 *   mode selector). No duration cap (Pro feature).
 */
export function useCommentRecorder(options: {
	onFinish: (recording: CommentRecording) => void;
	/** User dismissed the browser's picker/prompt — treat as a silent cancel. */
	onPickerCancelled?: () => void;
	selectedCameraId: string | null;
	selectedMicId: string | null;
	/** Acquisition landed on a camera — reconcile the selection UI. */
	onCameraInUse?: (deviceId: string | null) => void;
	/** Acquisition landed on a mic — reconcile the selection UI. */
	onMicInUse?: (deviceId: string | null) => void;
	/** Permission was granted; device labels are enumerable now. */
	onDevicesChanged?: () => void;
}) {
	const [phase, setPhase] = useState<CommentRecorderPhase>("idle");
	const [micMuted, setMicMuted] = useState(false);
	const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
	const [switchingCamera, setSwitchingCamera] = useState(false);
	// Mic switching mid-recording needs the mixer's stable output track; when
	// the recording has no audio graph the selector disables itself.
	const [liveMicSwitchable, setLiveMicSwitchable] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const cameraStreamRef = useRef<MediaStream | null>(null);
	const micStreamRef = useRef<MediaStream | null>(null);
	const displayStreamRef = useRef<MediaStream | null>(null);
	const mixedStreamRef = useRef<MediaStream | null>(null);
	const mixerRef = useRef<AudioMixer | null>(null);
	const phaseRef = useRef<CommentRecorderPhase>("idle");
	const micMutedRef = useRef(false);
	const discardRef = useRef(false);
	// Bumped by cancel/unmount so an acquisition suspended on a permission
	// prompt or picker knows its run was abandoned and stops the granted
	// tracks instead of recording into an unmounted component.
	const runIdRef = useRef(0);
	// Mic switches run on their own counter so a quick mic change can't
	// abandon an in-flight camera switch (and vice versa).
	const micRunRef = useRef(0);
	const pipelineMimeRef = useRef<string | null>(null);
	const hasAudioRef = useRef(false);
	const dimensionsRef = useRef<{ width?: number; height?: number }>({});
	const stopRef = useRef<(() => Promise<void>) | null>(null);
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const {
		mediaRecorderRef,
		setLocalRecordingStrategy,
		onRecorderDataAvailable,
		onRecorderStop,
		onRecorderError,
		stopRecordingInternal,
		resetRecorder,
	} = useMediaRecorderSetup();

	const {
		durationMs,
		clearTimer,
		startTimer,
		resetTimer,
		pauseTimer,
		resumeTimer,
		syncDurationFromClock,
	} = useRecordingTimer();

	const updatePhase = useCallback((next: CommentRecorderPhase) => {
		phaseRef.current = next;
		setPhase(next);
	}, []);

	const abandoned = useCallback(
		(runId: number, stream?: MediaStream | null) => {
			if (runId === runIdRef.current && !discardRef.current) return false;
			if (stream) for (const track of stream.getTracks()) track.stop();
			return true;
		},
		[],
	);

	const cleanupStreams = useCallback(() => {
		const stopAll = (stream: MediaStream | null) => {
			if (stream) for (const track of stream.getTracks()) track.stop();
		};
		stopAll(cameraStreamRef.current);
		cameraStreamRef.current = null;
		stopAll(micStreamRef.current);
		micStreamRef.current = null;
		stopAll(displayStreamRef.current);
		displayStreamRef.current = null;
		stopAll(mixedStreamRef.current);
		mixedStreamRef.current = null;
		const mixer = mixerRef.current;
		mixerRef.current = null;
		if (mixer) void mixer.close();
		setLiveMicSwitchable(false);
		setSwitchingCamera(false);
		setPreviewStream(null);
	}, []);

	const applyMicMuted = useCallback((stream: MediaStream | null) => {
		if (!stream) return;
		for (const track of stream.getAudioTracks())
			track.enabled = !micMutedRef.current;
	}, []);

	const failRecording = useCallback(
		(message: string) => {
			cleanupStreams();
			clearTimer();
			resetRecorder();
			resetTimer();
			setError(message);
			updatePhase("idle");
		},
		[cleanupStreams, clearTimer, resetRecorder, resetTimer, updatePhase],
	);

	const stop = useCallback(async () => {
		if (phaseRef.current !== "recording" && phaseRef.current !== "paused")
			return;
		// The timer's pause accounting rolls any open pause into the sync, so a
		// stop from "paused" reports only the actively recorded time.
		const recordedMs = syncDurationFromClock();
		const mime =
			mediaRecorderRef.current?.mimeType ||
			pipelineMimeRef.current ||
			"video/webm";
		const { width, height } = dimensionsRef.current;
		const hasAudio = hasAudioRef.current;
		updatePhase("processing");

		let blob: Blob | null = null;
		try {
			blob = await stopRecordingInternal(cleanupStreams, clearTimer);
		} catch (cause) {
			console.error("Failed to finalize comment recording", cause);
		}
		resetRecorder();
		resetTimer();
		const discarded = discardRef.current;
		updatePhase("idle");

		if (discarded || !blob || blob.size === 0) return;
		optionsRef.current.onFinish({
			// The final blob comes back untyped from the chunk store; downstream
			// conversion sniffs blob.type, so stamp the negotiated mime on it.
			blob: blob.type ? blob : new Blob([blob], { type: mime }),
			mime,
			durationSeconds: recordedMs / 1000,
			width,
			height,
			hasAudio,
		});
	}, [
		cleanupStreams,
		clearTimer,
		mediaRecorderRef,
		resetRecorder,
		resetTimer,
		stopRecordingInternal,
		syncDurationFromClock,
		updatePhase,
	]);

	stopRef.current = stop;

	const beginRecording = useCallback(
		(stream: MediaStream) => {
			const hasAudio = stream.getAudioTracks().length > 0;
			const pipeline = selectCommentVideoPipeline(hasAudio);
			if (!pipeline) {
				failRecording("Recording isn't supported in this browser.");
				return;
			}
			let recorder: MediaRecorder;
			try {
				recorder = new MediaRecorder(stream, { mimeType: pipeline.mimeType });
			} catch {
				failRecording("Recording isn't supported in this browser.");
				return;
			}
			pipelineMimeRef.current = pipeline.mimeType;
			hasAudioRef.current = hasAudio;
			const settings = stream.getVideoTracks()[0]?.getSettings();
			dimensionsRef.current = {
				width: settings?.width,
				height: settings?.height,
			};

			setLocalRecordingStrategy({ mode: "full" });
			recorder.ondataavailable = (event) => onRecorderDataAvailable(event);
			recorder.onstop = onRecorderStop;
			recorder.onerror = onRecorderError;
			mediaRecorderRef.current = recorder;

			// The browser's own "Stop sharing" bar ends the video track; treat it
			// as a normal stop.
			stream.getVideoTracks()[0]?.addEventListener(
				"ended",
				() => {
					void stopRef.current?.();
				},
				{ once: true },
			);

			recorder.start(200);
			startTimer();
			setLiveMicSwitchable(mixerRef.current !== null);
			updatePhase("recording");
		},
		[
			failRecording,
			mediaRecorderRef,
			onRecorderDataAvailable,
			onRecorderError,
			onRecorderStop,
			setLocalRecordingStrategy,
			startTimer,
			updatePhase,
		],
	);

	/** Camera: acquire devices and enter live preview; `startCameraRecording` begins. */
	const openCamera = useCallback(async () => {
		setError(null);
		updatePhase("requesting");
		discardRef.current = false;
		const runId = ++runIdRef.current;
		const { selectedCameraId, selectedMicId } = optionsRef.current;

		let stream: MediaStream | null = null;
		let failure: unknown = null;
		try {
			stream = await acquireCameraWithMicStream({
				cameraId: selectedCameraId,
				micId: selectedMicId,
			});
		} catch (cause) {
			failure = cause;
			// A remembered device that's gone makes the exact constraint fail;
			// retry on system defaults before surfacing an error.
			if (!isUserCancellationError(cause)) {
				try {
					stream = await acquireCameraWithMicStream({});
					failure = null;
				} catch (retryCause) {
					failure = retryCause;
				}
			}
		}

		if (!stream) {
			if (runId !== runIdRef.current) return;
			updatePhase("idle");
			if (isUserCancellationError(failure)) {
				optionsRef.current.onPickerCancelled?.();
				return;
			}
			setError(getCaptureErrorMessage(failure, "camera"));
			return;
		}
		if (abandoned(runId, stream)) return;

		const videoTrack = stream.getVideoTracks()[0] ?? null;
		const audioTracks = stream.getAudioTracks();
		cameraStreamRef.current = videoTrack ? new MediaStream([videoTrack]) : null;
		micStreamRef.current =
			audioTracks.length > 0 ? new MediaStream(audioTracks) : null;
		applyMicMuted(micStreamRef.current);

		optionsRef.current.onCameraInUse?.(
			videoTrack?.getSettings().deviceId ?? null,
		);
		optionsRef.current.onMicInUse?.(
			audioTracks[0]?.getSettings().deviceId ?? null,
		);
		optionsRef.current.onDevicesChanged?.();

		setPreviewStream(cameraStreamRef.current);
		updatePhase("ready");
	}, [abandoned, applyMicMuted, updatePhase]);

	/** Swap the camera during preview. Recording locks the video track. */
	const switchCamera = useCallback(
		async (deviceId: string) => {
			if (phaseRef.current !== "ready") return;
			const runId = ++runIdRef.current;
			setSwitchingCamera(true);
			// Release first: most cameras (and every phone) can't be open twice.
			if (cameraStreamRef.current)
				for (const track of cameraStreamRef.current.getTracks()) track.stop();

			try {
				let stream: MediaStream;
				try {
					stream = await acquireCameraStream(deviceId);
				} catch (cause) {
					if (runId !== runIdRef.current || isUserCancellationError(cause))
						throw cause;
					// Device vanished between enumeration and the click.
					stream = await acquireCameraStream(null);
				}
				if (abandoned(runId, stream)) return;
				cameraStreamRef.current = stream;
				setPreviewStream(stream);
				optionsRef.current.onCameraInUse?.(
					stream.getVideoTracks()[0]?.getSettings().deviceId ?? null,
				);
			} catch (cause) {
				if (runId !== runIdRef.current) return;
				failRecording(getCaptureErrorMessage(cause, "camera"));
			} finally {
				if (runId === runIdRef.current) setSwitchingCamera(false);
			}
		},
		[abandoned, failRecording],
	);

	/** Swap the mic in preview, or live mid-recording through the mixer. */
	const switchMic = useCallback(
		async (deviceId: string) => {
			const currentPhase = phaseRef.current;
			if (
				currentPhase !== "ready" &&
				currentPhase !== "recording" &&
				currentPhase !== "paused"
			)
				return;
			if (currentPhase !== "ready" && !mixerRef.current) return;
			const lifecycleRun = runIdRef.current;
			const micRun = ++micRunRef.current;

			try {
				const stream = await acquireMicStream(deviceId);
				if (
					discardRef.current ||
					lifecycleRun !== runIdRef.current ||
					micRun !== micRunRef.current
				) {
					for (const track of stream.getTracks()) track.stop();
					return;
				}
				applyMicMuted(stream);
				const previous = micStreamRef.current;
				micStreamRef.current = stream;
				// Connect the new source before stopping the old one — no gap.
				mixerRef.current?.setMicStream(stream);
				if (previous) for (const track of previous.getTracks()) track.stop();
				optionsRef.current.onMicInUse?.(
					stream.getAudioTracks()[0]?.getSettings().deviceId ?? null,
				);
			} catch (cause) {
				if (lifecycleRun !== runIdRef.current || micRun !== micRunRef.current)
					return;
				console.warn("Failed to switch microphone", cause);
				// Snap the selection back to the mic that's actually live.
				optionsRef.current.onMicInUse?.(
					micStreamRef.current?.getAudioTracks()[0]?.getSettings().deviceId ??
						null,
				);
			}
		},
		[applyMicMuted],
	);

	const startCameraRecording = useCallback(async () => {
		if (phaseRef.current !== "ready" || switchingCamera) return;
		const cameraStream = cameraStreamRef.current;
		if (!cameraStream || cameraStream.getVideoTracks().length === 0) return;

		const micStream = micStreamRef.current;
		let audioTracks: MediaStreamTrack[] = [];
		if (micStream) {
			try {
				const mixer = await createAudioMixer({ micStream });
				mixerRef.current = mixer;
				audioTracks = mixer.stream.getAudioTracks();
			} catch (cause) {
				// No mixer means no live mic switching, but the recording must not
				// block on it — fall back to the raw track like the dashboard's
				// mic-only path.
				console.warn("Audio mixer unavailable, recording the mic track", cause);
				audioTracks = micStream.getAudioTracks();
			}
		}

		const mixed = new MediaStream([
			...cameraStream.getVideoTracks(),
			...audioTracks,
		]);
		mixedStreamRef.current = mixed;
		beginRecording(mixed);
	}, [beginRecording, switchingCamera]);

	/** Screen: picker immediately, then mic mix, then recording starts. */
	const startScreen = useCallback(async () => {
		setError(null);
		updatePhase("requesting");
		discardRef.current = false;
		const runId = ++runIdRef.current;

		let displayStream: MediaStream;
		try {
			displayStream = await acquireDisplayStream({ systemAudioEnabled: true });
		} catch (cause) {
			if (runId === runIdRef.current) updatePhase("idle");
			if (isUserCancellationError(cause)) {
				optionsRef.current.onPickerCancelled?.();
				return;
			}
			setError(getCaptureErrorMessage(cause, "display"));
			return;
		}
		if (abandoned(runId, displayStream)) return;
		displayStreamRef.current = displayStream;

		const { selectedMicId } = optionsRef.current;
		let micStream: MediaStream | null = null;
		try {
			micStream = await acquireMicStream(selectedMicId);
		} catch {
			if (selectedMicId) {
				try {
					micStream = await acquireMicStream(null);
				} catch {
					// No mic is fine; system audio (if granted) still records.
					micStream = null;
				}
			}
		}
		if (micStream && abandoned(runId, micStream)) return;
		if (abandoned(runId)) return;
		micStreamRef.current = micStream;
		applyMicMuted(micStream);
		if (micStream) {
			optionsRef.current.onMicInUse?.(
				micStream.getAudioTracks()[0]?.getSettings().deviceId ?? null,
			);
			optionsRef.current.onDevicesChanged?.();
		}

		const systemAudioTracks = displayStream.getAudioTracks();
		let audioTracks: MediaStreamTrack[] = [];
		if (systemAudioTracks.length > 0 || micStream) {
			try {
				const mixer = await createAudioMixer({ systemAudioTracks, micStream });
				if (abandoned(runId)) {
					void mixer.close();
					return;
				}
				mixerRef.current = mixer;
				audioTracks = mixer.stream.getAudioTracks();
			} catch (cause) {
				console.warn("Audio mixer unavailable, recording raw tracks", cause);
				audioTracks = [
					...systemAudioTracks,
					...(micStream?.getAudioTracks() ?? []),
				];
			}
		}

		const mixed = new MediaStream([
			...displayStream.getVideoTracks(),
			...audioTracks,
		]);
		mixedStreamRef.current = mixed;
		beginRecording(mixed);
	}, [abandoned, applyMicMuted, beginRecording, updatePhase]);

	/** Freeze the take: MediaRecorder holds its buffer, devices stay acquired
	 * (releasing them would re-prompt on resume), the clock stops counting. */
	const pause = useCallback(() => {
		if (phaseRef.current !== "recording") return;
		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state !== "recording") return;
		try {
			recorder.pause();
			pauseTimer();
			updatePhase("paused");
		} catch (cause) {
			console.error("Failed to pause comment recording", cause);
		}
	}, [mediaRecorderRef, pauseTimer, updatePhase]);

	const resume = useCallback(() => {
		if (phaseRef.current !== "paused") return;
		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state !== "paused") return;
		try {
			resumeTimer();
			recorder.resume();
			updatePhase("recording");
		} catch (cause) {
			console.error("Failed to resume comment recording", cause);
		}
	}, [mediaRecorderRef, resumeTimer, updatePhase]);

	const toggleMic = useCallback(() => {
		setMicMuted((muted) => {
			const next = !muted;
			micMutedRef.current = next;
			applyMicMuted(micStreamRef.current);
			return next;
		});
	}, [applyMicMuted]);

	const cancel = useCallback(() => {
		discardRef.current = true;
		runIdRef.current += 1;
		micRunRef.current += 1;
		if (phaseRef.current === "recording" || phaseRef.current === "paused") {
			void stopRef.current?.();
			return;
		}
		cleanupStreams();
		clearTimer();
		resetRecorder();
		resetTimer();
		updatePhase("idle");
	}, [cleanupStreams, clearTimer, resetRecorder, resetTimer, updatePhase]);

	const cancelRef = useRef(cancel);
	cancelRef.current = cancel;

	useEffect(
		() => () => {
			cancelRef.current();
		},
		[],
	);

	return {
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
		startScreen,
		toggleMic,
		pause,
		resume,
		stop,
		cancel,
	};
}

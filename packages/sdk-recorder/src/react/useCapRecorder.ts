import { useCallback, useEffect, useRef, useState } from "react";
import { CapRecorder } from "../index";
import type { RecorderOptions, RecorderPhase, RecordingResult } from "../types";

export function useCapRecorder(options: RecorderOptions) {
	const { publicKey, apiBase, mode, userId, camera, microphone, systemAudio } =
		options;
	const cameraEnabled = camera?.enabled;
	const cameraDeviceId = camera?.deviceId;
	const microphoneEnabled = microphone?.enabled;
	const microphoneDeviceId = microphone?.deviceId;
	const recorderRef = useRef<CapRecorder | null>(null);
	const [phase, setPhase] = useState<RecorderPhase>("idle");
	const [videoId, setVideoId] = useState<string | null>(null);
	const [durationMs, setDurationMs] = useState(0);

	useEffect(() => {
		const recorder = new CapRecorder({
			publicKey,
			apiBase,
			mode,
			userId,
			camera:
				cameraEnabled !== undefined || cameraDeviceId !== undefined
					? { enabled: cameraEnabled, deviceId: cameraDeviceId }
					: undefined,
			microphone:
				microphoneEnabled !== undefined || microphoneDeviceId !== undefined
					? { enabled: microphoneEnabled, deviceId: microphoneDeviceId }
					: undefined,
			systemAudio,
		});
		recorderRef.current = recorder;

		const unsubPhase = recorder.on("phasechange", (e) => {
			setPhase(e.phase);
		});
		const unsubDuration = recorder.on("durationchange", (e) => {
			setDurationMs(e.durationMs);
		});
		const unsubComplete = recorder.on("complete", (e) => {
			setVideoId(e.videoId);
		});

		return () => {
			unsubPhase();
			unsubDuration();
			unsubComplete();
			recorder.destroy();
		};
	}, [
		publicKey,
		apiBase,
		mode,
		userId,
		cameraEnabled,
		cameraDeviceId,
		microphoneEnabled,
		microphoneDeviceId,
		systemAudio,
	]);

	const start = useCallback(async () => {
		await recorderRef.current?.start();
	}, []);

	const pause = useCallback(() => {
		recorderRef.current?.pause();
	}, []);

	const resume = useCallback(() => {
		recorderRef.current?.resume();
	}, []);

	const stop = useCallback(async (): Promise<RecordingResult | undefined> => {
		return recorderRef.current?.stop();
	}, []);

	return {
		phase,
		videoId,
		durationMs,
		isRecording: phase === "recording",
		isPaused: phase === "paused",
		start,
		pause,
		resume,
		stop,
	};
}

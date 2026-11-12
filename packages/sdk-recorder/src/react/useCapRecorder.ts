import { useCallback, useEffect, useRef, useState } from "react";
import { CapRecorder } from "../index";
import type { RecorderOptions, RecorderPhase, RecordingResult } from "../types";

export function useCapRecorder(options: RecorderOptions) {
	const {
		createUpload,
		apiBase,
		mode,
		camera,
		microphone,
		systemAudio,
		maxDurationMs,
	} = options;
	const cameraEnabled = camera?.enabled;
	const cameraDeviceId = camera?.deviceId;
	const microphoneEnabled = microphone?.enabled;
	const microphoneDeviceId = microphone?.deviceId;
	const recorderRef = useRef<CapRecorder | null>(null);
	const createUploadRef = useRef(createUpload);
	createUploadRef.current = createUpload;
	const [phase, setPhase] = useState<RecorderPhase>("idle");
	const [videoId, setVideoId] = useState<string | null>(null);
	const [durationMs, setDurationMs] = useState(0);

	useEffect(() => {
		const recorder = new CapRecorder({
			createUpload: () => createUploadRef.current(),
			apiBase,
			mode,
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
		setPhase(recorder.phase);
		setVideoId(recorder.videoId);
		setDurationMs(recorder.durationMs);

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
		apiBase,
		mode,
		cameraEnabled,
		cameraDeviceId,
		microphoneEnabled,
		microphoneDeviceId,
		systemAudio,
	]);

	const start = useCallback(async () => {
		await recorderRef.current?.start({ maxDurationMs });
	}, [maxDurationMs]);

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

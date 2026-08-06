"use client";

import {
	type AudioMixer,
	acquireMicStream,
	createAudioMixer,
} from "@cap/recorder-core/capture-streams";
import { isUserCancellationError } from "@cap/recorder-core/recorder-utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaRecorderSetup } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useMediaRecorderSetup";
import { useRecordingTimer } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useRecordingTimer";
import { decodeToPeaks, LivePeaksAccumulator } from "./compute-waveform-peaks";
import { pickVoiceMime } from "./recorder-constraints";

export type VoiceRecorderPhase =
	| "idle"
	| "requesting"
	| "denied"
	| "recording"
	| "paused"
	| "processing";

export interface VoiceRecording {
	blob: Blob;
	mime: string;
	durationSeconds: number;
	waveform: number[] | undefined;
}

const LEVEL_SAMPLE_MS = 60;

/**
 * Audio-only recorder for voice-note comments, on the shared capture engine:
 * exact-device acquisition, and the mixer's stable output track feeding the
 * recorder so the mic can be swapped live mid-recording. One tap starts
 * (permission prompt included); live level samples feed both the on-screen
 * meter and the waveform the comment ships with. No duration cap (Pro).
 */
export function useVoiceRecorder(options: {
	onFinish: (recording: VoiceRecording) => void;
	/** Live meter callback (0..1), called ~16/sec while recording. */
	onLevel?: (level: number) => void;
	selectedMicId: string | null;
	/** Acquisition landed on a mic — reconcile the selection UI. */
	onMicInUse?: (deviceId: string | null) => void;
	/** Permission was granted; device labels are enumerable now. */
	onDevicesChanged?: () => void;
}) {
	const [phase, setPhase] = useState<VoiceRecorderPhase>("idle");

	const micStreamRef = useRef<MediaStream | null>(null);
	const mixerRef = useRef<AudioMixer | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const meterSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const peaksRef = useRef<LivePeaksAccumulator | null>(null);
	const levelTimerRef = useRef(0);
	const voiceMimeRef = useRef<string | null>(null);
	const phaseRef = useRef<VoiceRecorderPhase>("idle");
	const discardRef = useRef(false);
	// Bumped by cancel/unmount so a start() suspended on the permission prompt
	// can tell its run was abandoned — otherwise the granted mic stream would
	// record into an unmounted component with the indicator lit forever.
	const runIdRef = useRef(0);
	const micRunRef = useRef(0);
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

	const updatePhase = useCallback((next: VoiceRecorderPhase) => {
		phaseRef.current = next;
		setPhase(next);
	}, []);

	const cleanupStreams = useCallback(() => {
		if (levelTimerRef.current) window.clearInterval(levelTimerRef.current);
		levelTimerRef.current = 0;
		for (const track of micStreamRef.current?.getTracks() ?? []) track.stop();
		micStreamRef.current = null;
		meterSourceRef.current = null;
		analyserRef.current = null;
		const mixer = mixerRef.current;
		mixerRef.current = null;
		if (mixer) void mixer.close();
	}, []);

	/** Point the level meter at a (new) mic stream on the mixer's context. */
	const attachMeter = useCallback(
		(mixer: AudioMixer, micStream: MediaStream) => {
			try {
				let analyser = analyserRef.current;
				if (!analyser) {
					analyser = mixer.context.createAnalyser();
					analyser.fftSize = 256;
					analyserRef.current = analyser;
				}
				meterSourceRef.current?.disconnect();
				const source = mixer.context.createMediaStreamSource(micStream);
				source.connect(analyser);
				meterSourceRef.current = source;
			} catch {
				// Meter is cosmetic; recording continues, decodeToPeaks covers the
				// waveform on stop.
			}
		},
		[],
	);

	const start = useCallback(async () => {
		if (phaseRef.current === "recording" || phaseRef.current === "requesting")
			return;
		updatePhase("requesting");
		discardRef.current = false;
		const runId = ++runIdRef.current;
		const { selectedMicId } = optionsRef.current;

		let stream: MediaStream | null = null;
		try {
			stream = await acquireMicStream(selectedMicId);
		} catch (cause) {
			// A remembered mic that's gone fails the exact constraint; the system
			// default is the right fallback. Denials stay denials.
			if (selectedMicId && !isUserCancellationError(cause)) {
				try {
					stream = await acquireMicStream(null);
				} catch {
					stream = null;
				}
			}
		}
		if (!stream) {
			if (runId === runIdRef.current) updatePhase("denied");
			return;
		}
		if (runId !== runIdRef.current || discardRef.current) {
			for (const track of stream.getTracks()) track.stop();
			return;
		}
		micStreamRef.current = stream;
		optionsRef.current.onMicInUse?.(
			stream.getAudioTracks()[0]?.getSettings().deviceId ?? null,
		);
		optionsRef.current.onDevicesChanged?.();

		let mixer: AudioMixer | null = null;
		try {
			mixer = await createAudioMixer({ micStream: stream });
		} catch {
			// Recording continues on the raw track; mic switching is disabled.
			mixer = null;
		}
		if (runId !== runIdRef.current || discardRef.current) {
			if (mixer) void mixer.close();
			cleanupStreams();
			return;
		}
		mixerRef.current = mixer;
		if (mixer) attachMeter(mixer, stream);

		const mime = pickVoiceMime();
		voiceMimeRef.current = mime;
		let recorder: MediaRecorder;
		try {
			recorder = new MediaRecorder(
				mixer ? mixer.stream : stream,
				mime ? { mimeType: mime } : undefined,
			);
		} catch {
			cleanupStreams();
			updatePhase("denied");
			return;
		}
		setLocalRecordingStrategy({ mode: "full" });
		recorder.ondataavailable = (event) => onRecorderDataAvailable(event);
		recorder.onstop = onRecorderStop;
		recorder.onerror = onRecorderError;
		mediaRecorderRef.current = recorder;
		peaksRef.current = new LivePeaksAccumulator();

		// Live level meter: AnalyserNode RMS sampled on an interval — drives the
		// recording bar's canvas AND accumulates the persisted waveform.
		const analyser = analyserRef.current;
		if (analyser) {
			const buffer = new Float32Array(analyser.fftSize);
			levelTimerRef.current = window.setInterval(() => {
				// Paused: the recorder isn't consuming, so neither the on-screen
				// meter nor the persisted waveform should accumulate samples.
				if (phaseRef.current !== "recording") return;
				analyser.getFloatTimeDomainData(buffer);
				let sum = 0;
				for (const sample of buffer) sum += sample * sample;
				const level = Math.min(1, Math.sqrt(sum / buffer.length) * 3);
				peaksRef.current?.push(level);
				optionsRef.current.onLevel?.(level);
			}, LEVEL_SAMPLE_MS);
		}

		recorder.start(1000);
		startTimer();
		updatePhase("recording");
	}, [
		attachMeter,
		cleanupStreams,
		mediaRecorderRef,
		onRecorderDataAvailable,
		onRecorderError,
		onRecorderStop,
		setLocalRecordingStrategy,
		startTimer,
		updatePhase,
	]);

	/** Freeze the take without releasing the mic (resume must be instant). */
	const pause = useCallback(() => {
		if (phaseRef.current !== "recording") return;
		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state !== "recording") return;
		try {
			recorder.pause();
			pauseTimer();
			updatePhase("paused");
		} catch (cause) {
			console.error("Failed to pause voice note", cause);
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
			console.error("Failed to resume voice note", cause);
		}
	}, [mediaRecorderRef, resumeTimer, updatePhase]);

	/**
	 * Scrap the take and record again from zero, without touching the mic or
	 * the mixer: the old MediaRecorder is stopped with its handlers detached
	 * (its output evaporates), a fresh one starts on the same stream.
	 */
	const restart = useCallback(() => {
		if (phaseRef.current !== "recording" && phaseRef.current !== "paused")
			return;
		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state === "inactive") return;
		try {
			recorder.ondataavailable = null;
			recorder.onstop = null;
			recorder.onerror = null;
			recorder.stop();
		} catch {
			/* already stopping; the discard below still applies */
		}
		resetRecorder();

		const source = mixerRef.current
			? mixerRef.current.stream
			: micStreamRef.current;
		if (!source) {
			cleanupStreams();
			clearTimer();
			resetTimer();
			updatePhase("idle");
			return;
		}
		const mime = voiceMimeRef.current;
		let next: MediaRecorder;
		try {
			next = new MediaRecorder(source, mime ? { mimeType: mime } : undefined);
		} catch {
			cleanupStreams();
			clearTimer();
			resetTimer();
			updatePhase("denied");
			return;
		}
		setLocalRecordingStrategy({ mode: "full" });
		next.ondataavailable = (event) => onRecorderDataAvailable(event);
		next.onstop = onRecorderStop;
		next.onerror = onRecorderError;
		mediaRecorderRef.current = next;
		peaksRef.current = new LivePeaksAccumulator();
		next.start(1000);
		startTimer();
		updatePhase("recording");
	}, [
		cleanupStreams,
		clearTimer,
		mediaRecorderRef,
		onRecorderDataAvailable,
		onRecorderError,
		onRecorderStop,
		resetRecorder,
		resetTimer,
		setLocalRecordingStrategy,
		startTimer,
		updatePhase,
	]);

	/** Swap the mic live; the mixer keeps the recorded track uninterrupted. */
	const switchMic = useCallback(
		async (deviceId: string) => {
			if (
				(phaseRef.current !== "recording" && phaseRef.current !== "paused") ||
				!mixerRef.current
			)
				return;
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
				const previous = micStreamRef.current;
				micStreamRef.current = stream;
				const mixer = mixerRef.current;
				if (mixer) {
					mixer.setMicStream(stream);
					attachMeter(mixer, stream);
				}
				if (previous) for (const track of previous.getTracks()) track.stop();
				optionsRef.current.onMicInUse?.(
					stream.getAudioTracks()[0]?.getSettings().deviceId ?? null,
				);
			} catch (cause) {
				if (lifecycleRun !== runIdRef.current || micRun !== micRunRef.current)
					return;
				console.warn("Failed to switch microphone", cause);
				optionsRef.current.onMicInUse?.(
					micStreamRef.current?.getAudioTracks()[0]?.getSettings().deviceId ??
						null,
				);
			}
		},
		[attachMeter],
	);

	const stop = useCallback(async () => {
		if (phaseRef.current !== "recording" && phaseRef.current !== "paused")
			return;
		// Pause accounting folds any open pause in, so this is active time only.
		const recordedMs = syncDurationFromClock();
		const mime =
			mediaRecorderRef.current?.mimeType ||
			voiceMimeRef.current ||
			"audio/webm";
		updatePhase("processing");

		let blob: Blob | null = null;
		try {
			blob = await stopRecordingInternal(cleanupStreams, clearTimer);
		} catch (cause) {
			console.error("Failed to finalize voice note", cause);
		}
		const livePeaks = peaksRef.current?.finish();
		peaksRef.current = null;
		resetRecorder();
		resetTimer();

		if (discardRef.current || !blob || blob.size === 0) {
			updatePhase("idle");
			return;
		}

		const typedBlob = blob.type ? blob : new Blob([blob], { type: mime });
		const waveform = livePeaks ?? (await decodeToPeaks(typedBlob));
		optionsRef.current.onFinish({
			blob: typedBlob,
			mime,
			durationSeconds: recordedMs / 1000,
			waveform,
		});
		updatePhase("idle");
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

	const stopRef = useRef(stop);
	stopRef.current = stop;

	const cancel = useCallback(() => {
		discardRef.current = true;
		runIdRef.current += 1;
		micRunRef.current += 1;
		if (phaseRef.current === "recording" || phaseRef.current === "paused") {
			void stopRef.current();
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
		start,
		stop,
		pause,
		resume,
		restart,
		switchMic,
		cancel,
	};
}

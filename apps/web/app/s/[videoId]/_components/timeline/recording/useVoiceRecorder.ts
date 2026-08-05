"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeToPeaks, LivePeaksAccumulator } from "./compute-waveform-peaks";
import { MIC_CONSTRAINTS, pickVoiceMime } from "./recorder-constraints";

export type VoiceRecorderPhase =
	| "idle"
	| "requesting"
	| "denied"
	| "recording"
	| "processing";

export interface VoiceRecording {
	blob: Blob;
	mime: string;
	durationSeconds: number;
	waveform: number[] | undefined;
}

const LEVEL_SAMPLE_MS = 60;

/**
 * Audio-only recorder for voice-note comments: one tap starts (permission
 * prompt included), live level samples feed both the on-screen meter and the
 * waveform the comment ships with. No duration cap (Pro feature).
 */
export function useVoiceRecorder(options: {
	onFinish: (recording: VoiceRecording) => void;
	/** Live meter callback (0..1), called ~16/sec while recording. */
	onLevel?: (level: number) => void;
}) {
	const [phase, setPhase] = useState<VoiceRecorderPhase>("idle");
	const [durationMs, setDurationMs] = useState(0);

	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const audioContextRef = useRef<AudioContext | null>(null);
	const peaksRef = useRef<LivePeaksAccumulator | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const startedAtRef = useRef(0);
	const timersRef = useRef<{ level?: number; tick?: number }>({});
	const discardRef = useRef(false);
	// Bumped by cancel/unmount so a start() suspended on the permission prompt
	// can tell its run was abandoned — otherwise the granted mic stream would
	// record into an unmounted component with the indicator lit forever.
	const runIdRef = useRef(0);
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const cleanup = useCallback(() => {
		const { level, tick } = timersRef.current;
		if (level) window.clearInterval(level);
		if (tick) window.clearInterval(tick);
		timersRef.current = {};
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		void audioContextRef.current?.close().catch(() => {});
		audioContextRef.current = null;
		recorderRef.current = null;
	}, []);

	const start = useCallback(async () => {
		if (phase === "recording" || phase === "requesting") return;
		setPhase("requesting");
		discardRef.current = false;
		const runId = ++runIdRef.current;

		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: MIC_CONSTRAINTS,
			});
		} catch {
			if (runId === runIdRef.current) setPhase("denied");
			return;
		}
		if (runId !== runIdRef.current || discardRef.current) {
			for (const track of stream.getTracks()) track.stop();
			return;
		}
		streamRef.current = stream;

		const mime = pickVoiceMime();
		let recorder: MediaRecorder;
		try {
			recorder = new MediaRecorder(
				stream,
				mime ? { mimeType: mime } : undefined,
			);
		} catch {
			cleanup();
			setPhase("denied");
			return;
		}
		recorderRef.current = recorder;
		chunksRef.current = [];
		peaksRef.current = new LivePeaksAccumulator();

		// Live level meter: AnalyserNode RMS sampled on an interval — drives the
		// recording bar's canvas AND accumulates the persisted waveform.
		try {
			const audioContext = new AudioContext();
			audioContextRef.current = audioContext;
			const source = audioContext.createMediaStreamSource(stream);
			const analyser = audioContext.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			const buffer = new Float32Array(analyser.fftSize);
			timersRef.current.level = window.setInterval(() => {
				analyser.getFloatTimeDomainData(buffer);
				let sum = 0;
				for (const sample of buffer) sum += sample * sample;
				const level = Math.min(1, Math.sqrt(sum / buffer.length) * 3);
				peaksRef.current?.push(level);
				optionsRef.current.onLevel?.(level);
			}, LEVEL_SAMPLE_MS);
		} catch {
			// Meter is cosmetic; recording continues, decodeToPeaks covers the
			// waveform on stop.
		}

		recorder.addEventListener("dataavailable", (event) => {
			if (event.data.size > 0) chunksRef.current.push(event.data);
		});
		recorder.addEventListener("stop", () => {
			const elapsed = (performance.now() - startedAtRef.current) / 1000;
			const recordedMime = recorder.mimeType || mime || "audio/webm";
			const blob = new Blob(chunksRef.current, { type: recordedMime });
			chunksRef.current = [];
			const livePeaks = peaksRef.current?.finish();
			cleanup();

			if (discardRef.current || blob.size === 0) {
				setPhase("idle");
				setDurationMs(0);
				return;
			}

			setPhase("processing");
			void (async () => {
				const waveform = livePeaks ?? (await decodeToPeaks(blob));
				optionsRef.current.onFinish({
					blob,
					mime: recordedMime,
					durationSeconds: elapsed,
					waveform,
				});
				setPhase("idle");
				setDurationMs(0);
			})();
		});

		startedAtRef.current = performance.now();
		setDurationMs(0);
		timersRef.current.tick = window.setInterval(() => {
			setDurationMs(performance.now() - startedAtRef.current);
		}, 500);
		recorder.start(1000);
		setPhase("recording");
	}, [cleanup, phase]);

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

	return { phase, durationMs, start, stop, cancel };
}

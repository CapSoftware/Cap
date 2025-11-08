import { useCallback, useRef } from "react";
import type { RecorderErrorEvent } from "./web-recorder-types";

export const useMediaRecorderSetup = () => {
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const recordedChunksRef = useRef<Blob[]>([]);
	const totalRecordedBytesRef = useRef(0);
	const stopPromiseResolverRef = useRef<((blob: Blob) => void) | null>(null);
	const stopPromiseRejectRef = useRef<((reason?: unknown) => void) | null>(
		null,
	);
	const isStoppingRef = useRef(false);

	const onRecorderDataAvailable = useCallback(
		(event: BlobEvent, onChunk?: (chunk: Blob, totalBytes: number) => void) => {
			if (event.data && event.data.size > 0) {
				recordedChunksRef.current.push(event.data);
				totalRecordedBytesRef.current += event.data.size;
				onChunk?.(event.data, totalRecordedBytesRef.current);
			}
		},
		[],
	);

	const onRecorderStop = useCallback(() => {
		if (recordedChunksRef.current.length === 0) {
			const rejecter = stopPromiseRejectRef.current;
			stopPromiseResolverRef.current = null;
			stopPromiseRejectRef.current = null;
			isStoppingRef.current = false;
			rejecter?.(new Error("No recorded data"));
			return;
		}

		const blob = new Blob(recordedChunksRef.current, {
			type: recordedChunksRef.current[0]?.type ?? "video/webm;codecs=vp8,opus",
		});
		recordedChunksRef.current = [];
		const resolver = stopPromiseResolverRef.current;
		stopPromiseResolverRef.current = null;
		stopPromiseRejectRef.current = null;
		isStoppingRef.current = false;
		resolver?.(blob);
	}, []);

	const onRecorderError = useCallback((event: RecorderErrorEvent) => {
		const error = event.error ?? new DOMException("Recording error");
		const rejecter = stopPromiseRejectRef.current;
		stopPromiseResolverRef.current = null;
		stopPromiseRejectRef.current = null;
		isStoppingRef.current = false;
		rejecter?.(error);
	}, []);

	const stopRecordingInternal = useCallback(
		async (cleanupStreams: () => void, clearTimer: () => void) => {
			const recorder = mediaRecorderRef.current;
			if (!recorder || recorder.state === "inactive") return null;
			if (isStoppingRef.current) return null;

			isStoppingRef.current = true;

			const stopPromise = new Promise<Blob>((resolve, reject) => {
				stopPromiseResolverRef.current = resolve;
				stopPromiseRejectRef.current = reject;
			});

			recorder.stop();
			cleanupStreams();
			clearTimer();

			return stopPromise;
		},
		[],
	);

	const resetRecorder = useCallback(() => {
		mediaRecorderRef.current = null;
		recordedChunksRef.current = [];
		totalRecordedBytesRef.current = 0;
	}, []);

	return {
		mediaRecorderRef,
		recordedChunksRef,
		totalRecordedBytesRef,
		onRecorderDataAvailable,
		onRecorderStop,
		onRecorderError,
		stopRecordingInternal,
		resetRecorder,
	};
};

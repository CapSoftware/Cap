import {
	appendLocalRecordingChunk,
	finalizeLocalRecording,
	type LocalRecordingStrategy,
} from "@cap/recorder-core/local-recording-backup";
import type { RecorderErrorEvent } from "@cap/recorder-core/recorder-types";
import { useCallback, useRef, useState } from "react";

export const useMediaRecorderSetup = () => {
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const recordedChunksRef = useRef<Blob[]>([]);
	const totalRecordedBytesRef = useRef(0);
	const localRecordingStrategyRef = useRef<LocalRecordingStrategy>({
		mode: "full",
	});
	const retainedRecordingBytesRef = useRef(0);
	const localRecordingOverflowedRef = useRef(false);
	const stopPromiseResolverRef = useRef<((blob: Blob | null) => void) | null>(
		null,
	);
	const stopPromiseRejectRef = useRef<((reason?: unknown) => void) | null>(
		null,
	);
	const stopPromiseRef = useRef<Promise<Blob | null> | null>(null);
	const stoppedRef = useRef(false);
	const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const recorderErrorRef = useRef<Error | null>(null);
	const [recorderError, setRecorderError] = useState<Error | null>(null);

	const setLocalRecordingStrategy = useCallback(
		(strategy: LocalRecordingStrategy) => {
			localRecordingStrategyRef.current = strategy;
			recordedChunksRef.current = [];
			retainedRecordingBytesRef.current = 0;
			localRecordingOverflowedRef.current = false;
		},
		[],
	);

	const replaceLocalRecording = useCallback(
		(chunks: Blob[], strategy: LocalRecordingStrategy) => {
			localRecordingStrategyRef.current = strategy;
			recordedChunksRef.current = chunks.filter((chunk) => chunk.size > 0);
			retainedRecordingBytesRef.current = recordedChunksRef.current.reduce(
				(total, chunk) => total + chunk.size,
				0,
			);
			localRecordingOverflowedRef.current = false;
		},
		[],
	);

	const appendToLocalRecording = useCallback((chunk: Blob) => {
		if (chunk.size === 0) {
			return;
		}

		const nextState = appendLocalRecordingChunk(
			{
				chunks: recordedChunksRef.current,
				retainedBytes: retainedRecordingBytesRef.current,
				overflowed: localRecordingOverflowedRef.current,
			},
			chunk,
			{ mode: "full" },
		);
		recordedChunksRef.current = nextState.chunks;
		retainedRecordingBytesRef.current = nextState.retainedBytes;
		localRecordingOverflowedRef.current = nextState.overflowed;
	}, []);

	const onRecorderDataAvailable = useCallback(
		(event: BlobEvent, onChunk?: (chunk: Blob, totalBytes: number) => void) => {
			if (event.target && event.target !== mediaRecorderRef.current) return;
			if (event.data && event.data.size > 0) {
				totalRecordedBytesRef.current += event.data.size;
				const nextState = appendLocalRecordingChunk(
					{
						chunks: recordedChunksRef.current,
						retainedBytes: retainedRecordingBytesRef.current,
						overflowed: localRecordingOverflowedRef.current,
					},
					event.data,
					localRecordingStrategyRef.current,
				);
				recordedChunksRef.current = nextState.chunks;
				retainedRecordingBytesRef.current = nextState.retainedBytes;
				localRecordingOverflowedRef.current = nextState.overflowed;
				onChunk?.(event.data, totalRecordedBytesRef.current);
			}
		},
		[],
	);

	const getRecoveryBlob = useCallback(() => {
		return finalizeLocalRecording({
			chunks: recordedChunksRef.current,
			retainedBytes: retainedRecordingBytesRef.current,
			overflowed: localRecordingOverflowedRef.current,
		});
	}, []);

	const onRecorderStop = useCallback(
		(event?: Event) => {
			if (event?.target && event.target !== mediaRecorderRef.current) return;
			stoppedRef.current = true;
			if (stopTimeoutRef.current !== null) {
				clearTimeout(stopTimeoutRef.current);
				stopTimeoutRef.current = null;
			}
			const blob = getRecoveryBlob();
			const resolver = stopPromiseResolverRef.current;
			const rejecter = stopPromiseRejectRef.current;
			const error =
				recorderErrorRef.current ??
				(!resolver
					? new Error("The browser stopped recording unexpectedly")
					: null);
			if (error) {
				recorderErrorRef.current = error;
				stopPromiseResolverRef.current = null;
				stopPromiseRejectRef.current = null;
				stopPromiseRef.current = null;
				setRecorderError(error);
				rejecter?.(error);
				return;
			}

			if (!blob && localRecordingStrategyRef.current.mode === "full") {
				const rejecter = stopPromiseRejectRef.current;
				stopPromiseResolverRef.current = null;
				stopPromiseRejectRef.current = null;
				stopPromiseRef.current = null;
				rejecter?.(new Error("No recorded data"));
				return;
			}

			stopPromiseResolverRef.current = null;
			stopPromiseRejectRef.current = null;
			stopPromiseRef.current = null;
			resolver?.(blob);
		},
		[getRecoveryBlob],
	);

	const onRecorderError = useCallback((event: RecorderErrorEvent) => {
		if (event.target && event.target !== mediaRecorderRef.current) return;
		// MediaRecorder emits its final data after error and before stop.
		recorderErrorRef.current =
			event.error ?? new DOMException("Recording error");
	}, []);

	const stopRecordingInternal = useCallback(
		async (cleanupStreams: () => void, clearTimer: () => void) => {
			if (stopPromiseRef.current) return stopPromiseRef.current;
			const recorder = mediaRecorderRef.current;
			if (!recorder || stoppedRef.current) {
				cleanupStreams();
				clearTimer();
				if (recorderErrorRef.current) throw recorderErrorRef.current;
				return getRecoveryBlob();
			}

			const stopPromise = new Promise<Blob | null>((resolve, reject) => {
				stopPromiseResolverRef.current = resolve;
				stopPromiseRejectRef.current = reject;
				stopTimeoutRef.current = setTimeout(() => {
					const error = new Error(
						"The browser did not finish recording in time",
					);
					recorderErrorRef.current = error;
					stopPromiseResolverRef.current = null;
					stopPromiseRejectRef.current = null;
					stopTimeoutRef.current = null;
					stopPromiseRef.current = null;
					setRecorderError(error);
					reject(error);
				}, 30_000);
			});

			stopPromiseRef.current = stopPromise;

			try {
				if (recorder.state !== "inactive") recorder.stop();
			} catch (error) {
				if (stopTimeoutRef.current !== null)
					clearTimeout(stopTimeoutRef.current);
				stopTimeoutRef.current = null;
				stopPromiseRejectRef.current?.(error);
				stopPromiseResolverRef.current = null;
				stopPromiseRejectRef.current = null;
				stopPromiseRef.current = null;
			}
			cleanupStreams();
			clearTimer();

			return stopPromise;
		},
		[getRecoveryBlob],
	);

	const resetRecorder = useCallback(() => {
		if (stopTimeoutRef.current !== null) clearTimeout(stopTimeoutRef.current);
		stopTimeoutRef.current = null;
		stopPromiseRejectRef.current?.(new Error("Recording was reset"));
		stopPromiseResolverRef.current = null;
		stopPromiseRejectRef.current = null;
		stopPromiseRef.current = null;
		stoppedRef.current = false;
		mediaRecorderRef.current = null;
		recordedChunksRef.current = [];
		totalRecordedBytesRef.current = 0;
		localRecordingStrategyRef.current = { mode: "full" };
		retainedRecordingBytesRef.current = 0;
		localRecordingOverflowedRef.current = false;
		recorderErrorRef.current = null;
		setRecorderError(null);
	}, []);

	return {
		mediaRecorderRef,
		recorderError,
		getRecoveryBlob,
		recordedChunksRef,
		totalRecordedBytesRef,
		setLocalRecordingStrategy,
		replaceLocalRecording,
		appendToLocalRecording,
		onRecorderDataAvailable,
		onRecorderStop,
		onRecorderError,
		stopRecordingInternal,
		resetRecorder,
	};
};

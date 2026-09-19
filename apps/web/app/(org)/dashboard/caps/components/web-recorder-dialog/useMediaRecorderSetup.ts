import {
	appendLocalRecordingChunk,
	finalizeLocalRecording,
	type LocalRecordingStrategy,
} from "@cap/recorder-core/local-recording-backup";
import type { RecorderErrorEvent } from "@cap/recorder-core/recorder-types";
import { useCallback, useRef } from "react";

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
	const isStoppingRef = useRef(false);

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
		(
			chunks: Blob[],
			strategy: LocalRecordingStrategy,
			alreadyOverflowed = false,
		) => {
			localRecordingStrategyRef.current = strategy;
			const retainedChunks = chunks.filter((chunk) => chunk.size > 0);
			const retainedBytes = retainedChunks.reduce(
				(total, chunk) => total + chunk.size,
				0,
			);
			const overflowed =
				alreadyOverflowed ||
				(strategy.mode === "capped" && retainedBytes > strategy.maxBytes);
			recordedChunksRef.current = overflowed ? [] : retainedChunks;
			retainedRecordingBytesRef.current = overflowed ? 0 : retainedBytes;
			localRecordingOverflowedRef.current = overflowed;
			return overflowed;
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
			if (event.data && event.data.size > 0) {
				totalRecordedBytesRef.current += event.data.size;
				const wasOverflowed = localRecordingOverflowedRef.current;
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
				return !wasOverflowed && nextState.overflowed;
			}
			return false;
		},
		[],
	);

	const onRecorderStop = useCallback(() => {
		const blob = finalizeLocalRecording({
			chunks: recordedChunksRef.current,
			retainedBytes: retainedRecordingBytesRef.current,
			overflowed: localRecordingOverflowedRef.current,
		});

		if (!blob && localRecordingStrategyRef.current.mode === "full") {
			const rejecter = stopPromiseRejectRef.current;
			stopPromiseResolverRef.current = null;
			stopPromiseRejectRef.current = null;
			isStoppingRef.current = false;
			rejecter?.(new Error("No recorded data"));
			return;
		}

		recordedChunksRef.current = [];
		retainedRecordingBytesRef.current = 0;
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

			const stopPromise = new Promise<Blob | null>((resolve, reject) => {
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
		localRecordingStrategyRef.current = { mode: "full" };
		retainedRecordingBytesRef.current = 0;
		localRecordingOverflowedRef.current = false;
	}, []);

	return {
		mediaRecorderRef,
		recordedChunksRef,
		totalRecordedBytesRef,
		localRecordingOverflowedRef,
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

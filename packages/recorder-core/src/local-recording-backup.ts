export type LocalRecordingStrategy =
	| { mode: "off" }
	| { mode: "full" }
	| { mode: "capped"; maxBytes: number };

export type LocalRecordingState = {
	chunks: Blob[];
	retainedBytes: number;
	overflowed: boolean;
};

export const initialLocalRecordingState = (): LocalRecordingState => ({
	chunks: [],
	retainedBytes: 0,
	overflowed: false,
});

export const appendLocalRecordingChunk = (
	state: LocalRecordingState,
	chunk: Blob,
	strategy: LocalRecordingStrategy,
): LocalRecordingState => {
	if (chunk.size === 0 || strategy.mode === "off") {
		return state;
	}

	if (strategy.mode === "full") {
		return {
			chunks: [...state.chunks, chunk],
			retainedBytes: state.retainedBytes + chunk.size,
			overflowed: false,
		};
	}

	if (state.overflowed) {
		return state;
	}

	if (state.retainedBytes + chunk.size > strategy.maxBytes) {
		return {
			chunks: [],
			retainedBytes: 0,
			overflowed: true,
		};
	}

	return {
		chunks: [...state.chunks, chunk],
		retainedBytes: state.retainedBytes + chunk.size,
		overflowed: false,
	};
};

export const finalizeLocalRecording = (
	state: LocalRecordingState,
	fallbackMimeType?: string,
): Blob | null => {
	if (state.overflowed || state.chunks.length === 0) {
		return null;
	}

	return new Blob(state.chunks, {
		type:
			state.chunks[0]?.type ?? fallbackMimeType ?? "video/webm;codecs=vp8,opus",
	});
};

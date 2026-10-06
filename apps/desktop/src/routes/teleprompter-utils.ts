export function countWords(text: string) {
	return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

export function clamp(value: number, minimum: number, maximum: number) {
	return Math.min(Math.max(value, minimum), maximum);
}

export function calculatePlaybackSpeed(
	maximumScroll: number,
	wordCount: number,
	wordsPerMinute: number,
) {
	const durationSeconds =
		(Math.max(1, wordCount) / Math.max(1, wordsPerMinute)) * 60;
	return Math.max(0, maximumScroll) / Math.max(1, durationSeconds);
}

export function advancePlaybackPosition(
	position: number,
	maximumScroll: number,
	pixelsPerSecond: number,
	elapsedSeconds: number,
) {
	return Math.min(
		Math.max(0, maximumScroll),
		Math.max(0, position) +
			Math.max(0, pixelsPerSecond) * Math.max(0, elapsedSeconds),
	);
}

export type TeleprompterPlaybackState = {
	requested: boolean;
	recordingPaused: boolean;
};

export type TeleprompterPlaybackAction =
	| "play"
	| "pause"
	| "recording-paused"
	| "recording-resumed"
	| "recording-stopped";

export function updateTeleprompterPlayback(
	state: TeleprompterPlaybackState,
	action: TeleprompterPlaybackAction,
): TeleprompterPlaybackState {
	switch (action) {
		case "play":
			return { ...state, requested: true };
		case "pause":
			return { ...state, requested: false };
		case "recording-paused":
			return { ...state, recordingPaused: true };
		case "recording-resumed":
			return { ...state, recordingPaused: false };
		case "recording-stopped":
			return { requested: false, recordingPaused: false };
	}
}

export function teleprompterPlaybackRunning(state: TeleprompterPlaybackState) {
	return state.requested && !state.recordingPaused;
}

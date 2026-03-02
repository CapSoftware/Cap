export type RecordingMode = "fullscreen" | "window" | "tab" | "camera";

export type RecorderPhase =
	| "idle"
	| "requesting-permission"
	| "ready"
	| "recording"
	| "paused"
	| "stopping"
	| "uploading"
	| "complete"
	| "error";

export interface RecorderOptions {
	publicKey: string;
	apiBase?: string;
	userId?: string;
	mode?: RecordingMode;
	camera?: { deviceId?: string; enabled?: boolean };
	microphone?: { deviceId?: string; enabled?: boolean };
	systemAudio?: boolean;
}

export interface RecordingResult {
	videoId: string;
	shareUrl: string;
	embedUrl: string;
}

export type RecorderEventMap = {
	phasechange: { phase: RecorderPhase };
	durationchange: { durationMs: number };
	error: { error: Error };
	complete: RecordingResult;
};

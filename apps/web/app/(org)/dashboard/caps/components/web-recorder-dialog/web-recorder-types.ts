export type RecorderPhase =
	| "idle"
	| "recording"
	| "paused"
	| "creating"
	| "converting"
	| "uploading"
	| "completed"
	| "error";

export type RecorderErrorEvent = Event & { error?: DOMException };

type VideoNamespace = typeof import("@inflight/web-domain").Video;
export type PresignedPost = VideoNamespace["PresignedPost"]["Type"];
export type VideoId = VideoNamespace["VideoId"]["Type"];

export type ChunkUploadState = {
	partNumber: number;
	sizeBytes: number;
	uploadedBytes: number;
	progress: number; // 0-1 ratio for the chunk itself
	status: "queued" | "uploading" | "complete" | "error";
};

export type RecordingFailureDownload = {
	url: string;
	fileName: string;
};

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

type VideoNamespace = typeof import("@cap/web-domain").Video;
type StorageNamespace = typeof import("@cap/web-domain").Storage;
export type PresignedPost = VideoNamespace["PresignedPost"]["Type"];
export type UploadTarget = StorageNamespace["UploadTarget"]["Type"];
export type VideoId = VideoNamespace["VideoId"]["Type"];

export type ChunkUploadState = {
	partNumber: number;
	sizeBytes: number;
	uploadedBytes: number;
	progress: number;
	status: "queued" | "uploading" | "complete" | "error";
};

export type RecordingFailureDownload = {
	url: string;
	fileName: string;
};

export type RecoveredRecordingDownload = RecordingFailureDownload & {
	id: string;
	createdAt: number;
};

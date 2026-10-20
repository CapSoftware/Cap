import type { Storage, Video } from "@cap/web-domain";

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

// Derived from the server schema so contract drift fails to compile instead
// of surfacing at runtime.
export type UploadTarget = Storage.UploadTarget;

export type UploadStatus =
	| {
			status: "parsing";
	  }
	| {
			status: "creating";
	  }
	| {
			status: "converting";
			capId: string;
			progress: number;
	  }
	| {
			status: "uploadingThumbnail";
			capId: string;
			progress: number;
	  }
	| {
			status: "uploadingVideo";
			capId: string;
			progress: number;
			thumbnailUrl: string | undefined;
	  }
	| {
			status: "serverProcessing";
			capId: string;
	  };

export type VideoId = Video.VideoId;

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

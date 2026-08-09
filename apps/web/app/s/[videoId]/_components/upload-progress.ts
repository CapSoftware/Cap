/**
 * Pure upload-progress state helpers, split from `ProgressCircle.tsx` so the
 * players can reason about upload state without importing `useUploadProgress`
 * — whose RPC client drags the whole Effect runtime into the bundle. Only
 * `UploadProgressTracker` (mounted while an upload is actually live) pays for
 * that chunk.
 */

export type UploadProgress =
	| { status: "fetching" }
	| {
			status: "uploading";
			lastUpdated: Date;
			progress: number;
	  }
	| {
			status: "processing";
			lastUpdated: Date;
			progress: number;
			message: string | null;
	  }
	| {
			status: "generating_thumbnail";
			lastUpdated: Date;
			progress: number;
	  }
	| {
			status: "error";
			lastUpdated: Date;
			errorMessage: string | null;
			hasRawFallback: boolean;
	  }
	| {
			status: "failed";
			lastUpdated: Date;
	  };

export function shouldDeferPlaybackSource(
	uploadProgress: UploadProgress | null,
): boolean {
	return (
		uploadProgress?.status === "fetching" ||
		uploadProgress?.status === "uploading"
	);
}

export function shouldReloadPlaybackAfterUploadCompletes(
	previousUploadProgress: UploadProgress | null,
	uploadProgress: UploadProgress | null,
	options: { includeFetching?: boolean } = {},
): boolean {
	return (
		previousUploadProgress !== null &&
		(options.includeFetching || previousUploadProgress.status !== "fetching") &&
		uploadProgress === null
	);
}

export function canRetryFailedProcessing(
	uploadProgress: UploadProgress | null,
	canRetryProcessing: boolean,
): boolean {
	return canRetryProcessing && uploadProgress?.status === "error";
}

export function getUploadFailureMessage(
	uploadProgress: UploadProgress | null,
	canRetryProcessing: boolean,
): string {
	if (uploadProgress?.status === "error") {
		if (canRetryFailedProcessing(uploadProgress, canRetryProcessing)) {
			return uploadProgress.errorMessage || "Processing failed.";
		}

		return (
			uploadProgress.errorMessage ||
			"Processing failed. Ask the owner to retry processing or re-upload the recording."
		);
	}

	return "Upload stalled before processing finished. Re-upload the recording to continue.";
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * 60 * SECOND;
export const DAY = 24 * HOUR;
const STALE_PROCESSING_START_MS = 90 * SECOND;
const STALE_PROCESSING_PROGRESS_MS = 10 * MINUTE;
const STALE_THUMBNAIL_MS = 5 * MINUTE;

export function getStalledProcessingMessage(input: {
	phase:
		| "uploading"
		| "processing"
		| "generating_thumbnail"
		| "complete"
		| "error";
	updatedAt: Date;
	processingProgress: number;
}): string | null {
	const ageMs = Date.now() - input.updatedAt.getTime();

	if (input.phase === "processing") {
		if (input.processingProgress === 0 && ageMs > STALE_PROCESSING_START_MS) {
			return "Video processing did not start. Retry processing.";
		}

		if (ageMs > STALE_PROCESSING_PROGRESS_MS) {
			return "Video processing stalled. Retry processing.";
		}
	}

	if (input.phase === "generating_thumbnail" && ageMs > STALE_THUMBNAIL_MS) {
		return "Video finishing stalled. Retry processing.";
	}

	if (input.phase === "complete" && ageMs > STALE_THUMBNAIL_MS) {
		return "Video finishing stalled. Retry processing.";
	}

	return null;
}

import {
	InstantRecordingUploader,
	initiateMultipartUpload,
	MultipartCompletionUncertainError,
} from "@cap/recorder-core";
import type { Video } from "@cap/web-domain";

const MAX_EXPORT_BYTES = 12 * 1024 * 1024 * 1024;
const PART_BYTES = 16 * 1024 * 1024;
const MAX_FETCH_AHEAD_BYTES = 64 * 1024 * 1024;
const UPLOAD_DEADLINE_MS = 35 * 60 * 1000;

export type WebEditorExportMetadata = {
	duration: number;
	width: number;
	height: number;
	fps: number;
};

export type WebEditorShareProgress = {
	stage: "uploading" | "publishing" | "ready";
	fraction: number;
};

export function validWebEditorExport(
	size: number,
	metadata: WebEditorExportMetadata,
) {
	return (
		Number.isSafeInteger(size) &&
		size >= 1 &&
		size <= MAX_EXPORT_BYTES &&
		Number.isFinite(metadata.duration) &&
		metadata.duration > 0 &&
		metadata.duration <= 43_200 &&
		Number.isSafeInteger(metadata.width) &&
		Number.isSafeInteger(metadata.height) &&
		metadata.width >= 1 &&
		metadata.height >= 1 &&
		metadata.width * metadata.height <= 33_554_432 &&
		Number.isFinite(metadata.fps) &&
		metadata.fps >= 1 &&
		metadata.fps <= 240
	);
}

const SAVE_SUPERSEDED = "A newer save replaced this one";

function saveSuperseded(error: unknown) {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "SAVE_SUPERSEDED"
	);
}

export async function uploadWebEditorFile(
	videoId: string,
	browserSaveId: string,
	file: Blob,
	metadata: WebEditorExportMetadata,
	signal: AbortSignal,
	onProgress?: (progress: WebEditorShareProgress) => void,
) {
	const size = file.size;
	if (!validWebEditorExport(size, metadata))
		throw new Error("Rendered recording metadata is invalid");
	if (signal.aborted) throw new Error("Recording upload was canceled");
	const deadline = Date.now() + UPLOAD_DEADLINE_MS;
	// A cast rather than Video.VideoId.make: the value import would bring the
	// whole Effect runtime into the editor page.
	const video = videoId as Video.VideoId;
	const api = { extraBody: { replaceExisting: true, browserSaveId } };
	const target = await initiateMultipartUpload({
		videoId: video,
		contentType: "video/mp4",
		subpath: "result.mp4",
		api,
	}).catch((error: unknown) => {
		throw saveSuperseded(error) ? new Error(SAVE_SUPERSEDED) : error;
	});
	let uploadedBytes = 0;
	let reportedPercent = -1;
	let fatalError: Error | null = null;
	let completionUncertain = false;
	let finished = false;
	let publishingStarted = false;
	let cancellation: Promise<void> | null = null;
	const waiters = new Set<() => void>();
	const wake = () => {
		for (const waiter of waiters) waiter();
	};
	const uploader = new InstantRecordingUploader({
		videoId: video,
		uploadId: target.uploadId,
		provider: target.provider,
		mimeType: "video/mp4",
		subpath: "result.mp4",
		setUploadStatus: () => {},
		sendProgressUpdate: async (uploaded) => {
			uploadedBytes = Math.max(uploadedBytes, uploaded);
			const percent = Math.floor((uploadedBytes / size) * 100);
			if (percent !== reportedPercent) {
				reportedPercent = percent;
				onProgress?.({
					stage: publishingStarted ? "publishing" : "uploading",
					fraction: Math.min(1, uploadedBytes / size),
				});
			}
			wake();
		},
		onFatalError: (error) => {
			fatalError = error;
			wake();
		},
		api,
	});
	const canceled = () => {
		if (!finished && !completionUncertain) cancellation ??= uploader.cancel();
		wake();
	};
	signal.addEventListener("abort", canceled, { once: true });
	// A closed tab can't finish the upload, and a replacement left open would
	// hold the recording as uploading, so it is abandoned on the way out.
	const abandon = () => {
		if (finished || completionUncertain) return;
		void fetch("/api/upload/multipart/abort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId,
				uploadId: target.uploadId,
				subpath: "result.mp4",
			}),
			keepalive: true,
		}).catch(() => undefined);
	};
	window.addEventListener("pagehide", abandon);
	const waitForProgress = () =>
		new Promise<void>((resolve, reject) => {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				reject(new Error("Recording upload timed out"));
				return;
			}
			const timer = window.setTimeout(() => {
				waiters.delete(done);
				reject(new Error("Recording upload timed out"));
			}, remaining);
			const done = () => {
				waiters.delete(done);
				window.clearTimeout(timer);
				resolve();
			};
			waiters.add(done);
		});
	try {
		onProgress?.({ stage: "uploading", fraction: 0 });
		for (let offset = 0; offset < size; ) {
			while (offset - uploadedBytes >= MAX_FETCH_AHEAD_BYTES) {
				if (signal.aborted) throw new Error("Recording upload was canceled");
				if (fatalError) throw fatalError;
				await waitForProgress();
			}
			if (signal.aborted) throw new Error("Recording upload was canceled");
			if (fatalError) throw fatalError;
			if (Date.now() >= deadline) throw new Error("Recording upload timed out");
			const length = Math.min(PART_BYTES, size - offset);
			const chunk = file.slice(offset, offset + length, "video/mp4");
			offset += length;
			uploader.handleChunk(chunk, offset);
		}
		if (signal.aborted) throw new Error("Recording upload was canceled");
		publishingStarted = true;
		onProgress?.({
			stage: "publishing",
			fraction: Math.min(1, uploadedBytes / size),
		});
		try {
			await uploader.finalize({
				durationSeconds: metadata.duration,
				width: metadata.width,
				height: metadata.height,
				fps: metadata.fps,
				subpath: "result.mp4",
			});
		} catch (error) {
			if (saveSuperseded(error)) throw new Error(SAVE_SUPERSEDED);
			if (error instanceof MultipartCompletionUncertainError) {
				completionUncertain = true;
				throw new Error(
					"The upload may not have finished. Reload the share page to check, then save again if needed.",
				);
			}
			throw error;
		}
		finished = true;
		onProgress?.({ stage: "ready", fraction: 1 });
	} catch (error) {
		if (cancellation) await cancellation;
		else if (!completionUncertain) await uploader.cancel();
		throw error;
	} finally {
		signal.removeEventListener("abort", canceled);
		window.removeEventListener("pagehide", abandon);
		waiters.clear();
	}
}

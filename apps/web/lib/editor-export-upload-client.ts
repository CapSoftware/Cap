import {
	InstantRecordingUploader,
	initiateMultipartUpload,
	MultipartCompletionUncertainError,
} from "@cap/recorder-core";
import { Video } from "@cap/web-domain";

const MAX_EXPORT_BYTES = 12 * 1024 * 1024 * 1024;
const PART_BYTES = 16 * 1024 * 1024;
const MAX_FETCH_AHEAD_BYTES = 64 * 1024 * 1024;
const UPLOAD_DEADLINE_MS = 35 * 60 * 1000;
const PUBLICATION_WAIT_MS = 15_000;
const PUBLICATION_POLL_MS = 750;
const PUBLICATION_REQUEST_MS = 5_000;

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

function validExport(size: number, metadata: WebEditorExportMetadata) {
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
		Number.isSafeInteger(metadata.fps) &&
		metadata.fps >= 1 &&
		metadata.fps <= 240
	);
}

async function waitForPublishedReplacement(
	videoId: string,
	sessionId: string,
	uploadId: string,
	signal: AbortSignal,
) {
	const deadline = Date.now() + PUBLICATION_WAIT_MS;
	const path = `/api/editor/sessions/${encodeURIComponent(sessionId)}/share-status`;
	while (Date.now() < deadline && !signal.aborted) {
		let response: Response | null = null;
		try {
			response = await fetch(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoId, uploadId }),
				cache: "no-store",
				signal: AbortSignal.any([
					signal,
					AbortSignal.timeout(PUBLICATION_REQUEST_MS),
				]),
			});
		} catch {}
		if (
			response?.status === 400 ||
			response?.status === 403 ||
			response?.status === 404
		)
			throw new Error("Recording share confirmation is unavailable");
		if (response?.ok) {
			let value: unknown;
			try {
				value = await response.json();
			} catch {}
			if (typeof value === "object" && value !== null && "status" in value) {
				if (value.status === "published") return true;
				if (value.status === "superseded")
					throw new Error("Recording share was superseded by another upload");
			}
		}
		await new Promise<void>((resolve) => {
			const canceled = () => {
				window.clearTimeout(timer);
				resolve();
			};
			const timer = window.setTimeout(() => {
				signal.removeEventListener("abort", canceled);
				resolve();
			}, PUBLICATION_POLL_MS);
			signal.addEventListener("abort", canceled, { once: true });
			if (signal.aborted) canceled();
		});
	}
	return false;
}

export async function uploadWebEditorExport(
	videoId: string,
	sessionId: string,
	exportId: string,
	size: number,
	metadata: WebEditorExportMetadata,
	signal: AbortSignal,
	onProgress?: (progress: WebEditorShareProgress) => void,
) {
	if (!validExport(size, metadata))
		throw new Error("Rendered recording metadata is invalid");
	if (signal.aborted) throw new Error("Recording upload was canceled");
	const deadline = Date.now() + UPLOAD_DEADLINE_MS;
	const video = Video.VideoId.make(videoId);
	const api = { extraBody: { replaceExisting: true } };
	const target = await initiateMultipartUpload({
		videoId: video,
		contentType: "video/mp4",
		subpath: "result.mp4",
		api,
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
		if (signal.aborted) throw new Error("Recording upload was canceled");
		onProgress?.({ stage: "uploading", fraction: 0 });
		const basePath = `/api/editor/sessions/${encodeURIComponent(sessionId)}/exports/${encodeURIComponent(exportId)}/chunk`;
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
			const search = new URLSearchParams({
				videoId,
				offset: String(offset),
				length: String(length),
			});
			const response = await fetch(`${basePath}?${search}`, {
				signal,
				cache: "no-store",
			});
			if (
				response.status !== 206 ||
				response.headers.get("Content-Type") !== "video/mp4" ||
				response.headers.get("Content-Length") !== String(length) ||
				response.headers.get("Content-Range") !==
					`bytes ${offset}-${offset + length - 1}/${size}`
			) {
				throw new Error("Rendered recording chunk is unavailable");
			}
			const chunk = await response.blob();
			if (signal.aborted) throw new Error("Recording upload was canceled");
			if (chunk.size !== length)
				throw new Error("Rendered recording chunk was incomplete");
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
			if (!(error instanceof MultipartCompletionUncertainError)) throw error;
			completionUncertain = true;
			if (
				await waitForPublishedReplacement(
					videoId,
					sessionId,
					target.uploadId,
					signal,
				)
			) {
				finished = true;
				onProgress?.({ stage: "ready", fraction: 1 });
				return;
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
		waiters.clear();
	}
}

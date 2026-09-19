import {
	InstantRecordingUploader,
	MultipartCompletionUncertainError,
} from "@cap/recorder-core";
import { Video } from "@cap/web-domain";

const MAX_VIDEO_BYTES = 12 * 1024 * 1024 * 1024;
const IMPORT_DEADLINE_MS = 30 * 60 * 1000;
const VIDEO_PATH =
	/^content\/videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|avi|mkv|webm|wmv|m4v|flv)$/;
const VIDEO_TYPES: Record<string, string> = {
	mp4: "video/mp4",
	mov: "video/quicktime",
	avi: "video/x-msvideo",
	mkv: "video/x-matroska",
	webm: "video/webm",
	wmv: "video/x-ms-wmv",
	m4v: "video/mp4",
	flv: "video/x-flv",
};

export type WebEditorImportedVideo = {
	jobId: string;
	path: string;
	name: string;
	duration: number;
	fps: number;
	width: number;
	height: number;
	hasAudio: boolean;
};

export type WebEditorVideoImportProgress = {
	stage: "uploading" | "staging" | "ready";
	fraction: number;
};

type PreparedEditorVideo = {
	key: string;
	path: string;
	uploadId: string;
	provider: "s3" | "googleDrive";
};

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preparedVideo(
	value: unknown,
	ownerId: string,
	videoId: string,
): PreparedEditorVideo | null {
	if (!asRecord(value)) return null;
	const { key, path, uploadId, provider } = value;
	if (
		typeof key !== "string" ||
		typeof path !== "string" ||
		!VIDEO_PATH.test(path) ||
		key !==
			`${ownerId}/${videoId}/editor-assets/videos/${path.slice("content/videos/".length)}` ||
		typeof uploadId !== "string" ||
		uploadId.length < 1 ||
		uploadId.length > 8192 ||
		(provider !== "s3" && provider !== "googleDrive")
	) {
		return null;
	}
	return {
		key,
		path,
		uploadId,
		provider: provider === "s3" ? "s3" : "googleDrive",
	};
}

function importedVideo(value: unknown, expectedPath: string) {
	if (!asRecord(value)) return null;
	const { path, name, duration, fps, width, height, hasAudio } = value;
	if (
		path !== expectedPath ||
		typeof name !== "string" ||
		name.length < 1 ||
		name.length > 100 ||
		typeof duration !== "number" ||
		!Number.isFinite(duration) ||
		duration <= 0 ||
		typeof fps !== "number" ||
		!Number.isSafeInteger(fps) ||
		fps < 1 ||
		fps > 240 ||
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 1 ||
		height < 1 ||
		width * height > 33_554_432 ||
		typeof hasAudio !== "boolean"
	) {
		return null;
	}
	return { path, name, duration, fps, width, height, hasAudio };
}

function pollDelay(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Video import was canceled"));
			return;
		}
		const timer = window.setTimeout(() => {
			signal.removeEventListener("abort", canceled);
			resolve();
		}, 1000);
		const canceled = () => {
			window.clearTimeout(timer);
			reject(new Error("Video import was canceled"));
		};
		signal.addEventListener("abort", canceled, { once: true });
	});
}

async function stageUploadedVideo(
	basePath: string,
	videoId: string,
	key: string,
	path: string,
	signal: AbortSignal,
): Promise<WebEditorImportedVideo> {
	const search = new URLSearchParams({ videoId, key, path });
	const started = await fetch(`${basePath}?${search}`, {
		signal,
		cache: "no-store",
	});
	if (!started.ok) throw new Error("Imported video could not be staged");
	const value: unknown = await started.json();
	if (
		!asRecord(value) ||
		typeof value.id !== "string" ||
		!/^[0-9a-f-]{36}$/.test(value.id) ||
		value.status !== "staging"
	) {
		throw new Error("Imported video staging response was invalid");
	}
	const jobId = value.id;
	const deadline = Date.now() + IMPORT_DEADLINE_MS;
	while (Date.now() < deadline) {
		const response = await fetch(
			`${basePath}/${encodeURIComponent(jobId)}?${search}`,
			{ signal, cache: "no-store" },
		);
		if (!response.ok)
			throw new Error("Imported video staging status is unavailable");
		const job: unknown = await response.json();
		if (!asRecord(job) || job.id !== jobId) {
			throw new Error("Imported video staging status was invalid");
		}
		if (job.status === "ready") {
			const result = importedVideo(job.result, path);
			if (!result) throw new Error("Imported video details were invalid");
			return { ...result, jobId };
		}
		if (job.status === "error" || job.status === "canceled") {
			throw new Error(
				typeof job.error === "string"
					? job.error
					: "Imported video could not be staged",
			);
		}
		if (job.status !== "staging") {
			throw new Error("Imported video staging status was invalid");
		}
		await pollDelay(signal);
	}
	throw new Error("Imported video staging timed out");
}

export async function importWebEditorVideo(
	file: File,
	videoId: string,
	ownerId: string,
	sessionId: string,
	signal: AbortSignal,
	onProgress?: (progress: WebEditorVideoImportProgress) => void,
): Promise<WebEditorImportedVideo> {
	const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
	const contentType = VIDEO_TYPES[extension];
	if (
		!contentType ||
		file.size < 1 ||
		file.size > MAX_VIDEO_BYTES ||
		file.name.length > 100
	) {
		throw new Error("Unsupported video file or file is too large");
	}
	if (signal.aborted) throw new Error("Video import was canceled");
	onProgress?.({ stage: "uploading", fraction: 0 });
	const basePath = `/api/editor/sessions/${encodeURIComponent(sessionId)}/video-assets`;
	const preparation = await fetch(basePath, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId,
			fileName: file.name,
			size: file.size,
			contentType,
		}),
		signal,
	});
	if (!preparation.ok)
		throw new Error("Video upload could not start in the editor");
	const target = preparedVideo(await preparation.json(), ownerId, videoId);
	if (!target) throw new Error("Video upload target was invalid");
	let uploadedFraction = 0;
	let reportedPercent = -1;
	const uploader = new InstantRecordingUploader({
		videoId: Video.VideoId.make(videoId),
		uploadId: target.uploadId,
		provider: target.provider,
		mimeType: contentType,
		subpath: target.key,
		setUploadStatus: () => {},
		sendProgressUpdate: async (uploaded, total) => {
			if (total > 0) {
				uploadedFraction = Math.min(1, uploaded / total);
				const percent = Math.floor(uploadedFraction * 100);
				if (percent !== reportedPercent) {
					reportedPercent = percent;
					onProgress?.({ stage: "uploading", fraction: uploadedFraction });
				}
			}
		},
		api: {
			multipartBasePath: basePath,
			extraBody: { key: target.key, path: target.path },
		},
	});
	let uncertain = false;
	const canceled = () => {
		if (uploadedFraction < 1) void uploader.cancel();
	};
	signal.addEventListener("abort", canceled, { once: true });
	try {
		try {
			await uploader.finalize({
				durationSeconds: 0,
				subpath: target.key,
				finalBlob: file,
			});
		} catch (error) {
			if (!(error instanceof MultipartCompletionUncertainError)) throw error;
			uncertain = true;
		}
		onProgress?.({ stage: "staging", fraction: 1 });
		const imported = await stageUploadedVideo(
			basePath,
			videoId,
			target.key,
			target.path,
			signal,
		);
		onProgress?.({ stage: "ready", fraction: 1 });
		return imported;
	} catch (error) {
		if (!uncertain && !signal.aborted) await uploader.cancel();
		throw error;
	} finally {
		signal.removeEventListener("abort", canceled);
	}
}

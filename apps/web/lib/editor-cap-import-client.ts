import {
	CAP_BUNDLE_CONTENT_TYPE,
	MAX_CAP_BUNDLE_BYTES,
} from "@cap/editor-cap-bundle";
import {
	InstantRecordingUploader,
	MultipartCompletionUncertainError,
} from "@cap/recorder-core";
import { Video } from "@cap/web-domain";

const IMPORT_DEADLINE_MS = 30 * 60 * 1000;
const CAP_BUNDLE_PATH =
	/^content\/imports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.capbundle$/;

export type WebEditorImportedCap = {
	jobId: string;
	path: string;
	name: string;
	clipCount: number;
};

export type WebEditorCapImportProgress = {
	kind: "cap";
	stage: "uploading" | "importing" | "ready";
	fraction: number;
};

type PreparedCap = {
	key: string;
	path: string;
	uploadId: string;
	provider: "s3" | "googleDrive";
};

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preparedCap(
	value: unknown,
	ownerId: string,
	videoId: string,
): PreparedCap | null {
	if (!asRecord(value)) return null;
	const { key, path, uploadId, provider } = value;
	if (
		typeof key !== "string" ||
		typeof path !== "string" ||
		!CAP_BUNDLE_PATH.test(path) ||
		key !==
			`${ownerId}/${videoId}/editor-assets/recordings/${path.slice("content/imports/".length)}` ||
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

function importedCap(value: unknown, expectedPath: string) {
	if (!asRecord(value)) return null;
	const { path, name, clipCount } = value;
	if (
		path !== expectedPath ||
		typeof name !== "string" ||
		name.length < 1 ||
		name.length > 100 ||
		typeof clipCount !== "number" ||
		!Number.isSafeInteger(clipCount) ||
		clipCount < 1 ||
		clipCount > 1000
	) {
		return null;
	}
	return { path, name, clipCount };
}

function pollDelay(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Cap project import was canceled"));
			return;
		}
		const timer = window.setTimeout(() => {
			signal.removeEventListener("abort", canceled);
			resolve();
		}, 1000);
		const canceled = () => {
			window.clearTimeout(timer);
			reject(new Error("Cap project import was canceled"));
		};
		signal.addEventListener("abort", canceled, { once: true });
	});
}

async function stageUploadedCap(
	basePath: string,
	videoId: string,
	key: string,
	path: string,
	signal: AbortSignal,
): Promise<WebEditorImportedCap> {
	const search = new URLSearchParams({ videoId, key, path });
	const started = await fetch(`${basePath}?${search}`, {
		signal,
		cache: "no-store",
	});
	if (!started.ok) throw new Error("Cap project could not be staged");
	const value: unknown = await started.json();
	if (
		!asRecord(value) ||
		typeof value.id !== "string" ||
		!/^[0-9a-f-]{36}$/.test(value.id) ||
		value.status !== "staging"
	) {
		throw new Error("Cap project staging response was invalid");
	}
	const jobId = value.id;
	const deadline = Date.now() + IMPORT_DEADLINE_MS;
	let completed = false;
	try {
		while (Date.now() < deadline) {
			const response = await fetch(
				`${basePath}/${encodeURIComponent(jobId)}?${search}`,
				{ signal, cache: "no-store" },
			);
			if (!response.ok)
				throw new Error("Cap project import status is unavailable");
			const job: unknown = await response.json();
			if (!asRecord(job) || job.id !== jobId) {
				throw new Error("Cap project import status was invalid");
			}
			if (job.status === "ready") {
				const result = importedCap(job.result, path);
				if (!result) throw new Error("Cap project import details were invalid");
				completed = true;
				return { ...result, jobId };
			}
			if (job.status === "error" || job.status === "canceled") {
				throw new Error(
					typeof job.error === "string"
						? job.error
						: "Cap project could not be imported",
				);
			}
			if (job.status !== "staging") {
				throw new Error("Cap project import status was invalid");
			}
			await pollDelay(signal);
		}
		throw new Error("Cap project import timed out");
	} finally {
		if (!completed) {
			await fetch(`${basePath}/${encodeURIComponent(jobId)}?${search}`, {
				method: "DELETE",
				signal: AbortSignal.timeout(10_000),
			}).catch(() => undefined);
		}
	}
}

export async function importWebEditorCap(
	file: File,
	videoId: string,
	ownerId: string,
	sessionId: string,
	signal: AbortSignal,
	onProgress?: (progress: WebEditorCapImportProgress) => void,
): Promise<WebEditorImportedCap> {
	if (
		!/\.capbundle$/i.test(file.name) ||
		file.type !== CAP_BUNDLE_CONTENT_TYPE ||
		file.size < 1 ||
		file.size > MAX_CAP_BUNDLE_BYTES ||
		file.name.length > 100
	) {
		throw new Error("Unsupported Cap project bundle or project is too large");
	}
	if (signal.aborted) throw new Error("Cap project import was canceled");
	onProgress?.({ kind: "cap", stage: "uploading", fraction: 0 });
	const basePath = `/api/editor/sessions/${encodeURIComponent(sessionId)}/video-assets`;
	const preparation = await fetch(basePath, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId,
			fileName: file.name,
			size: file.size,
			contentType: CAP_BUNDLE_CONTENT_TYPE,
		}),
		signal,
	});
	if (!preparation.ok) {
		throw new Error("Cap project upload could not start in the editor");
	}
	const target = preparedCap(await preparation.json(), ownerId, videoId);
	if (!target) throw new Error("Cap project upload target was invalid");
	let uploadedFraction = 0;
	let reportedPercent = -1;
	const uploader = new InstantRecordingUploader({
		videoId: Video.VideoId.make(videoId),
		uploadId: target.uploadId,
		provider: target.provider,
		mimeType: CAP_BUNDLE_CONTENT_TYPE,
		subpath: target.key,
		setUploadStatus: () => {},
		sendProgressUpdate: async (uploaded, total) => {
			if (total > 0) {
				uploadedFraction = Math.min(1, uploaded / total);
				const percent = Math.floor(uploadedFraction * 100);
				if (percent !== reportedPercent) {
					reportedPercent = percent;
					onProgress?.({
						kind: "cap",
						stage: "uploading",
						fraction: uploadedFraction,
					});
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
		onProgress?.({ kind: "cap", stage: "importing", fraction: 1 });
		const imported = await stageUploadedCap(
			basePath,
			videoId,
			target.key,
			target.path,
			signal,
		);
		onProgress?.({ kind: "cap", stage: "ready", fraction: 1 });
		return imported;
	} catch (error) {
		if (!uncertain && !signal.aborted) await uploader.cancel();
		throw error;
	} finally {
		signal.removeEventListener("abort", canceled);
	}
}

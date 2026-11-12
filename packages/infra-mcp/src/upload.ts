import { type FileHandle, open } from "node:fs/promises";
import {
	ApiError,
	isCancelled,
	isUnanswered,
	LocalError,
	withContext,
} from "./errors";
import { inspectFile, type LocalFile, storageTimeoutMs } from "./files";
import {
	asRecord,
	confirmed,
	dataOf,
	type InfraClient,
	storagePut,
} from "./http";
import type { RouteName } from "./routes";
import { cancelled, sleep } from "./time";

export const MAX_VIDEO_BYTES = 36_000_000_000;
export const MAX_PARTS = 10_000;
export const PART_URL_BATCH = 50;
const PART_URL_REUSE_MS = 30 * 60 * 1000;
const PART_ATTEMPTS = 3;
const COMPLETE_ATTEMPTS = 6;
const ABORT_BUDGET_MS = 10_000;

export type UploadTuning = {
	partBytes: number;
	partConcurrency: number;
	retryDelayMs: number;
	completionRetryMs: number;
};

export const DEFAULT_UPLOAD_TUNING: UploadTuning = {
	partBytes: 8 * 1024 * 1024,
	partConcurrency: 4,
	retryDelayMs: 1_000,
	completionRetryMs: 3_000,
};

export type VideoUploadInput = {
	path: string;
	videoId?: string;
	name?: string;
	userId?: string;
	maxResolutionTier?: string;
	metadata?: Record<string, unknown>;
	durationSeconds?: number;
};

export type VideoUploadHooks = {
	signal?: AbortSignal;
	onVideo?: (videoId: string) => void;
	onProgress?: (done: number, total: number) => void;
};

export type VideoUploadResult = {
	videoId: string;
	playbackId: string | null;
	shareUrl: string | null;
	embedUrl: string | null;
	bytes: number;
	parts: number;
};

type CompletedPart = { partNumber: number; etag: string; size: number };

const optional = (value: unknown) =>
	typeof value === "string" && value.length > 0 ? value : null;

function required(value: unknown) {
	const found = optional(value);
	if (found === null) {
		throw new LocalError(
			"unexpected_response",
			"Cap answered in a shape this server does not understand",
			"Check that CAP_API_URL points at a Cap server, then run the tool again.",
		);
	}
	return found;
}

class UploadSession {
	private renewal: Promise<string> | null = null;

	constructor(
		private readonly client: InfraClient,
		readonly videoId: string,
		private token: string,
	) {}

	async call(
		name: RouteName,
		body: Record<string, unknown>,
		options: { signal?: AbortSignal; deadlineAt?: number } = {},
	) {
		const sent = this.token;
		try {
			return await this.client.call(name, { body, token: sent, ...options });
		} catch (error) {
			const expired =
				error instanceof ApiError && error.code === "upload_token_expired";
			if (!expired) throw error;
			const token = await this.renew(sent, options.signal);
			return this.client.call(name, { body, token, ...options });
		}
	}

	private renew(expired: string, signal?: AbortSignal) {
		if (this.token !== expired) return Promise.resolve(this.token);
		this.renewal ??= this.client
			.call("renewUploadToken", { id: this.videoId, signal })
			.then((reply) => {
				this.token = required(dataOf(reply).token);
				return this.token;
			})
			.finally(() => {
				this.renewal = null;
			});
		return this.renewal;
	}
}

async function readPart(file: FileHandle, position: number, length: number) {
	const buffer = Buffer.allocUnsafe(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await file.read(
			buffer,
			filled,
			length - filled,
			position + filled,
		);
		if (bytesRead === 0) {
			throw new LocalError(
				"file_changed",
				"The file changed while it was being uploaded",
				"Let the file finish writing, then upload it again.",
			);
		}
		filled += bytesRead;
	}
	return buffer;
}

async function sendParts(
	session: UploadSession,
	file: LocalFile,
	uploadId: string,
	tuning: UploadTuning,
	hooks: VideoUploadHooks,
): Promise<CompletedPart[]> {
	const partBytes = Math.max(
		tuning.partBytes,
		Math.ceil(file.size / MAX_PARTS),
	);
	const total = Math.ceil(file.size / partBytes);
	if (hooks.signal?.aborted) throw cancelled();
	const stop = new AbortController();
	const onAbort = () => stop.abort();
	hooks.signal?.addEventListener("abort", onAbort, { once: true });

	const urls = new Map<number, { url: string; at: number }>();
	let batches: Promise<void> = Promise.resolve();

	const fresh = (partNumber: number) => {
		const known = urls.get(partNumber);
		return known && Date.now() - known.at < PART_URL_REUSE_MS
			? known.url
			: null;
	};

	const urlFor = async (partNumber: number) => {
		const cached = fresh(partNumber);
		if (cached) return cached;
		const batch = batches.then(async () => {
			if (fresh(partNumber)) return;
			const partNumbers = Array.from(
				{ length: Math.min(PART_URL_BATCH, total - partNumber + 1) },
				(_, offset) => partNumber + offset,
			);
			const reply = asRecord(
				await session.call(
					"partUrls",
					{ videoId: session.videoId, uploadId, partNumbers },
					{ signal: stop.signal },
				),
			);
			const at = Date.now();
			for (const part of Array.isArray(reply.parts) ? reply.parts : []) {
				const { partNumber: number, presignedUrl } = asRecord(part);
				if (typeof number === "number" && typeof presignedUrl === "string") {
					urls.set(number, { url: presignedUrl, at });
				}
			}
		});
		batches = batch.catch(() => {});
		await batch;
		return required(fresh(partNumber));
	};

	const sendPart = async (
		handle: FileHandle,
		partNumber: number,
	): Promise<CompletedPart> => {
		const position = (partNumber - 1) * partBytes;
		const size = Math.min(partBytes, file.size - position);
		const bytes = await readPart(handle, position, size);
		let failure = "no answer";
		for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
			const url = await urlFor(partNumber);
			try {
				const stored = await storagePut(url, bytes, {
					signal: stop.signal,
					timeoutMs: storageTimeoutMs(size),
				});
				const accepted = stored.status >= 200 && stored.status < 300;
				if (accepted && stored.etag) {
					return { partNumber, etag: stored.etag, size };
				}
				failure = accepted ? "no ETag" : `status ${stored.status}`;
			} catch (error) {
				if (!isUnanswered(error)) throw error;
				failure = error.code;
			}
			urls.delete(partNumber);
			if (attempt < PART_ATTEMPTS) {
				await sleep(tuning.retryDelayMs * attempt, stop.signal);
			}
		}
		throw new LocalError(
			"part_upload_failed",
			`Part ${partNumber} of ${total} could not be stored (${failure})`,
			null,
		);
	};

	const handle = await open(file.path, "r");
	const completed: CompletedPart[] = [];
	let next = 1;
	const worker = async () => {
		for (;;) {
			if (stop.signal.aborted) throw cancelled();
			const partNumber = next++;
			if (partNumber > total) return;
			completed.push(await sendPart(handle, partNumber));
			hooks.onProgress?.(completed.length, total);
		}
	};

	try {
		const workers = Array.from(
			{ length: Math.min(tuning.partConcurrency, total) },
			worker,
		);
		await Promise.all(workers).catch(async (error: unknown) => {
			stop.abort();
			await Promise.allSettled(workers);
			throw hooks.signal?.aborted ? cancelled() : error;
		});
	} finally {
		hooks.signal?.removeEventListener("abort", onAbort);
		await handle.close().catch(() => {});
	}
	return completed.sort((a, b) => a.partNumber - b.partNumber);
}

const completionUnknown = (error: unknown) =>
	isUnanswered(error) ||
	(error instanceof ApiError && error.code === "completion_in_progress");

async function complete(
	session: UploadSession,
	uploadId: string,
	parts: CompletedPart[],
	durationInSecs: number,
	tuning: UploadTuning,
	signal?: AbortSignal,
) {
	const body = { videoId: session.videoId, uploadId, parts, durationInSecs };
	for (let attempt = 1; ; attempt++) {
		try {
			confirmed(await session.call("completeUpload", body, { signal }));
			return;
		} catch (error) {
			if (!completionUnknown(error) || attempt >= COMPLETE_ATTEMPTS) {
				throw error;
			}
			await sleep(
				error instanceof ApiError && error.retryAfterSeconds
					? error.retryAfterSeconds * 1000
					: tuning.completionRetryMs,
				signal,
			);
		}
	}
}

export async function uploadVideo(
	client: InfraClient,
	tuning: UploadTuning,
	input: VideoUploadInput,
	hooks: VideoUploadHooks = {},
): Promise<VideoUploadResult> {
	const file = await inspectFile(input.path, {
		maxBytes: MAX_VIDEO_BYTES,
		what: "a video",
	});

	const created =
		input.videoId === undefined
			? dataOf(
					await client.call("createUpload", {
						body: {
							name: input.name ?? file.title,
							...(input.userId === undefined ? {} : { userId: input.userId }),
							...(input.maxResolutionTier === undefined
								? {}
								: { maxResolutionTier: input.maxResolutionTier }),
							...(input.metadata === undefined
								? {}
								: { metadata: input.metadata }),
						},
						signal: hooks.signal,
					}),
				)
			: dataOf(
					await client.call("renewUploadToken", {
						id: input.videoId,
						signal: hooks.signal,
					}),
				);

	const videoId = input.videoId ?? required(created.videoId ?? created.id);
	const session = new UploadSession(client, videoId, required(created.token));
	hooks.onVideo?.(videoId);

	let uploadId: string | null = null;
	let completing = false;
	try {
		uploadId = required(
			asRecord(
				await session.call(
					"initiateUpload",
					{
						videoId,
						contentType: file.contentType,
						contentLength: file.size,
					},
					{ signal: hooks.signal },
				),
			).uploadId,
		);
		const parts = await sendParts(session, file, uploadId, tuning, hooks);
		completing = true;
		await complete(
			session,
			uploadId,
			parts,
			input.durationSeconds ?? 1,
			tuning,
			hooks.signal,
		);
		return {
			videoId,
			playbackId: optional(created.playbackId),
			shareUrl: optional(created.shareUrl),
			embedUrl: optional(created.embedUrl),
			bytes: file.size,
			parts: parts.length,
		};
	} catch (error) {
		const unknown =
			completing && (isCancelled(error) || completionUnknown(error));
		if (uploadId !== null && !unknown) {
			await session
				.call(
					"abortUpload",
					{ videoId, uploadId },
					{ deadlineAt: Date.now() + ABORT_BUDGET_MS },
				)
				.catch(() => {});
		}
		throw withContext(error, {
			videoId,
			videoStatus: unknown ? "unknown" : "uploading",
			next: unknown
				? "The upload may have completed. Check it with videos_get before uploading again."
				: "The video exists with no file. Run videos_upload again with this videoId to retry, or remove it with videos_delete.",
		});
	}
}

export const CHUNK_SIZE = 8 * 1024 * 1024;
export const CONCURRENCY = 6;
const PRESIGN_BATCH = 50;
const PRESIGNED_URL_REUSE_MS = 30 * 60 * 1000;

type CompletedPart = { partNumber: number; etag: string; size: number };

export class MultipartClient {
	private apiBase: string;
	private token: string;

	constructor(apiBase: string, token: string) {
		this.apiBase = apiBase;
		this.token = token;
	}

	private async request(path: string, body: unknown, signal?: AbortSignal) {
		const response = await fetch(
			`${this.apiBase}/api/developer/sdk/v1${path}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.token}`,
				},
				body: JSON.stringify(body),
				signal,
			},
		);
		if (!response.ok) {
			const text = await response.text().catch(() => "Unknown error");
			throw new Error(`SDK API error (${response.status}): ${text}`);
		}
		return response.json();
	}

	private async abortUpload(videoId: string, uploadId: string) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);
		try {
			await this.request(
				"/upload/multipart/abort",
				{ videoId, uploadId },
				controller.signal,
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	async uploadBlob(
		videoId: string,
		blob: Blob,
		options?: {
			durationMs?: number;
			onProgress?: (progress: number) => void;
		},
	): Promise<void> {
		const { uploadId } = await this.request("/upload/multipart/initiate", {
			videoId,
			contentType: blob.type || "video/mp4",
			...(blob.size > 0 ? { contentLength: blob.size } : {}),
		});

		const controller = new AbortController();
		const totalParts = Math.ceil(blob.size / CHUNK_SIZE);
		const completedParts: CompletedPart[] = [];

		const presignedUrls = new Map<number, string>();
		let presignedAt = 0;
		let signedThrough = 0;
		let presigning: Promise<void> | null = null;
		const presignFrom = async (firstPart: number) => {
			const lastPart = Math.min(firstPart + PRESIGN_BATCH - 1, totalParts);
			signedThrough = lastPart;
			const { parts } = (await this.request(
				"/upload/multipart/presign-part",
				{
					videoId,
					uploadId,
					partNumbers: Array.from(
						{ length: lastPart - firstPart + 1 },
						(_, offset) => firstPart + offset,
					),
				},
				controller.signal,
			)) as { parts: { partNumber: number; presignedUrl: string }[] };
			for (const part of parts) {
				presignedUrls.set(part.partNumber, part.presignedUrl);
			}
			presignedAt = Date.now();
		};

		// Parts start in order, so the part that finds no URL is the lowest one
		// still unsigned. Every worker waits on that one request rather than each
		// signing its own batch. A part the last request covered but the server
		// left out stays missing instead of being asked for again.
		const presignedUrlFor = async (partNumber: number) => {
			while (presigning) await presigning;
			if (Date.now() - presignedAt > PRESIGNED_URL_REUSE_MS) {
				presignedUrls.clear();
				signedThrough = 0;
			}
			if (!presignedUrls.has(partNumber) && partNumber > signedThrough) {
				presigning = presignFrom(partNumber).finally(() => {
					presigning = null;
				});
				await presigning;
			}
			const presignedUrl = presignedUrls.get(partNumber);
			if (!presignedUrl) {
				throw new Error(`Missing presigned URL for part ${partNumber}`);
			}
			return presignedUrl;
		};

		const uploadPart = async (idx: number): Promise<CompletedPart> => {
			const start = idx * CHUNK_SIZE;
			const end = Math.min(start + CHUNK_SIZE, blob.size);
			const partNumber = idx + 1;
			const presignedUrl = await presignedUrlFor(partNumber);

			const uploadResponse = await fetch(presignedUrl, {
				method: "PUT",
				body: blob.slice(start, end),
				signal: controller.signal,
			});

			if (!uploadResponse.ok) {
				await uploadResponse.body?.cancel().catch(() => {});
				throw new Error(`Failed to upload part ${partNumber}`);
			}

			const etag = uploadResponse.headers.get("ETag");
			if (!etag) throw new Error(`Missing ETag for part ${partNumber}`);
			return { partNumber, etag, size: end - start };
		};

		// Each worker takes the next part as soon as its last one finishes, so a
		// slow part holds up one slot instead of a whole batch.
		let nextIndex = 0;
		const worker = async () => {
			while (nextIndex < totalParts && !controller.signal.aborted) {
				const part = await uploadPart(nextIndex++);
				if (controller.signal.aborted) return;
				completedParts.push(part);
				options?.onProgress?.(completedParts.length / totalParts);
			}
		};

		try {
			const workers = Array.from(
				{ length: Math.min(CONCURRENCY, totalParts) },
				worker,
			);
			await Promise.all(workers).catch(async (error: unknown) => {
				controller.abort();
				await Promise.allSettled(workers);
				throw error;
			});
		} catch (error) {
			controller.abort();
			await this.abortUpload(videoId, uploadId).catch(() => {});
			throw error;
		}

		const durationInSecs = options?.durationMs ? options.durationMs / 1000 : 1;

		await this.request("/upload/multipart/complete", {
			videoId,
			uploadId,
			parts: completedParts.sort((a, b) => a.partNumber - b.partNumber),
			durationInSecs,
		});
	}
}

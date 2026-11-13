const CHUNK_SIZE = 5 * 1024 * 1024;
const CONCURRENCY = 3;
const PRESIGN_BATCH = 50;
const PRESIGNED_URL_REUSE_MS = 30 * 60 * 1000;

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
		const completedParts: Array<{
			partNumber: number;
			etag: string;
			size: number;
		}> = [];

		const presignedUrls = new Map<number, string>();
		let presignedAt = 0;
		const presignFrom = async (firstPart: number) => {
			const { parts } = (await this.request(
				"/upload/multipart/presign-part",
				{
					videoId,
					uploadId,
					partNumbers: Array.from(
						{ length: Math.min(PRESIGN_BATCH, totalParts - firstPart + 1) },
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

		const uploadPart = async (idx: number) => {
			const start = idx * CHUNK_SIZE;
			const end = Math.min(start + CHUNK_SIZE, blob.size);
			const partNumber = idx + 1;
			const presignedUrl = presignedUrls.get(partNumber);
			if (!presignedUrl) {
				throw new Error(`Missing presigned URL for part ${partNumber}`);
			}

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

		try {
			for (let i = 0; i < totalParts; i += CONCURRENCY) {
				const batch = Array.from(
					{ length: Math.min(CONCURRENCY, totalParts - i) },
					(_, j) => i + j,
				);
				if (Date.now() - presignedAt > PRESIGNED_URL_REUSE_MS) {
					presignedUrls.clear();
				}
				const unsigned = batch.find((idx) => !presignedUrls.has(idx + 1));
				if (unsigned !== undefined) await presignFrom(unsigned + 1);

				const tasks = batch.map(uploadPart);
				const results = await Promise.all(tasks).catch(
					async (error: unknown) => {
						controller.abort();
						await Promise.allSettled(tasks);
						throw error;
					},
				);
				completedParts.push(...results);
				options?.onProgress?.(completedParts.length / totalParts);
			}
		} catch (error) {
			controller.abort();
			await this.abortUpload(videoId, uploadId).catch(() => {});
			throw error;
		}

		const durationInSecs = options?.durationMs ? options.durationMs / 1000 : 1;

		await this.request("/upload/multipart/complete", {
			videoId,
			uploadId,
			parts: completedParts,
			durationInSecs,
		});
	}
}

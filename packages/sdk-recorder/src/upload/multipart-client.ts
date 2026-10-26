const CHUNK_SIZE = 5 * 1024 * 1024;

export class MultipartClient {
	private apiBase: string;
	private publicKey: string;

	constructor(apiBase: string, publicKey: string) {
		this.apiBase = apiBase;
		this.publicKey = publicKey;
	}

	private async request(path: string, body: unknown, signal?: AbortSignal) {
		const response = await fetch(
			`${this.apiBase}/api/developer/sdk/v1${path}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.publicKey}`,
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

	async createVideo(options?: {
		name?: string;
		userId?: string;
		metadata?: Record<string, unknown>;
	}): Promise<{
		videoId: string;
		s3Key: string;
		shareUrl: string;
		embedUrl: string;
	}> {
		return this.request("/videos/create", options ?? {});
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
		});

		const controller = new AbortController();
		const totalParts = Math.ceil(blob.size / CHUNK_SIZE);
		const completedParts: Array<{
			partNumber: number;
			etag: string;
			size: number;
		}> = [];

		const CONCURRENCY = 3;
		for (let i = 0; i < totalParts; i += CONCURRENCY) {
			const batch = Array.from(
				{ length: Math.min(CONCURRENCY, totalParts - i) },
				(_, j) => i + j,
			);

			const tasks = batch.map(async (idx) => {
				const start = idx * CHUNK_SIZE;
				const end = Math.min(start + CHUNK_SIZE, blob.size);
				const chunk = blob.slice(start, end);
				const partNumber = idx + 1;

				const { presignedUrl } = await this.request(
					"/upload/multipart/presign-part",
					{
						videoId,
						uploadId,
						partNumber,
					},
					controller.signal,
				);

				const uploadResponse = await fetch(presignedUrl, {
					method: "PUT",
					body: chunk,
					signal: controller.signal,
				});

				if (!uploadResponse.ok) {
					await uploadResponse.body?.cancel().catch(() => {});
					throw new Error(`Failed to upload part ${partNumber}`);
				}

				const etag = uploadResponse.headers.get("ETag");
				if (!etag) throw new Error(`Missing ETag for part ${partNumber}`);
				return {
					partNumber,
					etag,
					size: end - start,
				};
			});
			await Promise.all(tasks)
				.then((results) => {
					completedParts.push(...results);
					options?.onProgress?.(completedParts.length / totalParts);
				})
				.catch(async (error: unknown) => {
					controller.abort();
					await Promise.allSettled(tasks);
					await this.abortUpload(videoId, uploadId).catch(() => {});
					throw error;
				});
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

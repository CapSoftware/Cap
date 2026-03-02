const CHUNK_SIZE = 5 * 1024 * 1024;

export class MultipartClient {
	private apiBase: string;
	private publicKey: string;

	constructor(apiBase: string, publicKey: string) {
		this.apiBase = apiBase;
		this.publicKey = publicKey;
	}

	private async request(path: string, body: unknown) {
		const response = await fetch(
			`${this.apiBase}/api/developer/sdk/v1${path}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.publicKey}`,
				},
				body: JSON.stringify(body),
			},
		);
		if (!response.ok) {
			const text = await response.text().catch(() => "Unknown error");
			throw new Error(`SDK API error (${response.status}): ${text}`);
		}
		return response.json();
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
		onProgress?: (progress: number) => void,
	): Promise<void> {
		const { uploadId } = await this.request("/upload/multipart/initiate", {
			videoId,
			contentType: blob.type || "video/mp4",
		});

		const totalParts = Math.ceil(blob.size / CHUNK_SIZE);
		const completedParts: Array<{
			partNumber: number;
			etag: string;
			size: number;
		}> = [];

		for (let i = 0; i < totalParts; i++) {
			const start = i * CHUNK_SIZE;
			const end = Math.min(start + CHUNK_SIZE, blob.size);
			const chunk = blob.slice(start, end);
			const partNumber = i + 1;

			const { presignedUrl } = await this.request(
				"/upload/multipart/presign-part",
				{
					videoId,
					uploadId,
					partNumber,
				},
			);

			const uploadResponse = await fetch(presignedUrl, {
				method: "PUT",
				body: chunk,
			});

			if (!uploadResponse.ok) {
				await this.request("/upload/multipart/abort", {
					videoId,
					uploadId,
				});
				throw new Error(`Failed to upload part ${partNumber}`);
			}

			const etag = uploadResponse.headers.get("ETag") ?? "";
			completedParts.push({
				partNumber,
				etag,
				size: end - start,
			});

			onProgress?.(completedParts.length / totalParts);
		}

		await this.request("/upload/multipart/complete", {
			videoId,
			uploadId,
			parts: completedParts,
		});
	}
}

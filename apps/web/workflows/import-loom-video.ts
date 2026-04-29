import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import { S3Bucket, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { FatalError } from "workflow";
import { runPromise } from "@/lib/server";

interface ImportLoomPayload {
	videoId: string;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
	loomDownloadUrl: string;
	loomVideoId: string;
}

const MINIMUM_VIDEO_SIZE = 1024;

function isStreamingUrl(url: string): boolean {
	const path = (url.split("?")[0] ?? "").toLowerCase();
	return path.endsWith(".m3u8") || path.endsWith(".mpd");
}

async function fetchLoomCdnUrl(
	videoId: string,
	endpoint: string,
	includeBody: boolean,
): Promise<string | null> {
	try {
		const options: RequestInit = { method: "POST" };
		if (includeBody) {
			options.headers = {
				"Content-Type": "application/json",
				Accept: "application/json",
			};
			options.body = JSON.stringify({
				anonID: randomUUID(),
				deviceID: null,
				force_original: false,
				password: null,
			});
		}

		const response = await fetch(
			`https://www.loom.com/api/campaigns/sessions/${videoId}/${endpoint}`,
			options,
		);

		if (!response.ok || response.status === 204) return null;

		const text = await response.text();
		if (!text.trim()) return null;

		const data = JSON.parse(text) as { url?: string };
		return data.url ?? null;
	} catch {
		return null;
	}
}

async function fetchFreshLoomDownloadUrl(loomVideoId: string): Promise<string> {
	const requestVariants: Array<{ endpoint: string; includeBody: boolean }> = [
		{ endpoint: "transcoded-url", includeBody: true },
		{ endpoint: "raw-url", includeBody: true },
		{ endpoint: "transcoded-url", includeBody: false },
		{ endpoint: "raw-url", includeBody: false },
	];

	let fallbackStreamingUrl: string | null = null;

	for (const { endpoint, includeBody } of requestVariants) {
		const url = await fetchLoomCdnUrl(loomVideoId, endpoint, includeBody);
		if (!url) continue;

		if (!isStreamingUrl(url)) return url;

		if (!fallbackStreamingUrl) fallbackStreamingUrl = url;
	}

	if (fallbackStreamingUrl) return fallbackStreamingUrl;

	throw new FatalError(
		"Could not retrieve a download URL from Loom. The video may be private, password-protected, or the link may have expired.",
	);
}

async function downloadVideoContent(downloadUrl: string): Promise<Buffer> {
	const loomResponse = await fetch(downloadUrl);
	if (!loomResponse.ok) {
		throw new FatalError(
			`Failed to download from Loom: ${loomResponse.status} ${loomResponse.statusText}`,
		);
	}

	const contentType = loomResponse.headers.get("content-type") ?? "";
	if (
		contentType.includes("text/html") ||
		contentType.includes("application/json")
	) {
		throw new FatalError(
			`Loom returned non-video content (${contentType}). The download URL may have expired.`,
		);
	}

	return Buffer.from(await loomResponse.arrayBuffer());
}

interface VideoProcessingResult {
	success: boolean;
	message: string;
	metadata?: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

interface LoomProcessingInput {
	sourceVideoUrl?: string;
	inputExtension?: string;
}

export async function importLoomVideoWorkflow(
	payload: ImportLoomPayload,
): Promise<VideoProcessingResult> {
	"use workflow";

	const processingInput = await downloadLoomToS3(payload);

	const result = await processVideoOnMediaServer(payload, processingInput);

	await saveMetadataAndComplete(payload.videoId, result.metadata);

	return {
		success: true,
		message: "Loom video imported successfully",
		metadata: result.metadata,
	};
}

function getInputExtension(url: string): string | undefined {
	const pathname = new URL(url).pathname.toLowerCase();

	if (pathname.endsWith(".m3u8")) {
		return ".m3u8";
	}

	if (pathname.endsWith(".mpd")) {
		return ".mpd";
	}

	if (pathname.endsWith(".mp4")) {
		return ".mp4";
	}

	return undefined;
}

async function downloadLoomToS3(
	payload: ImportLoomPayload,
): Promise<LoomProcessingInput> {
	"use step";

	const { videoId, loomVideoId, rawFileKey, bucketId } = payload;

	await db()
		.update(videoUploads)
		.set({
			phase: "uploading",
			processingProgress: 0,
			processingMessage: "Downloading from Loom...",
			rawFileKey,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));

	const freshDownloadUrl = await fetchFreshLoomDownloadUrl(loomVideoId);

	if (isStreamingUrl(freshDownloadUrl)) {
		await db()
			.update(videoUploads)
			.set({
				phase: "processing",
				processingProgress: 0,
				processingMessage: "Starting video processing...",
				updatedAt: new Date(),
			})
			.where(eq(videoUploads.videoId, videoId as Video.VideoId));

		return {
			sourceVideoUrl: freshDownloadUrl,
			inputExtension: getInputExtension(freshDownloadUrl),
		};
	}

	const bucketIdOption = Option.fromNullable(bucketId).pipe(
		Option.map((id) => S3Bucket.S3BucketId.make(id)),
	);

	const presignedPutUrl = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);
		return yield* bucket.getInternalPresignedPutUrl(rawFileKey, {
			ContentType: "video/mp4",
		});
	}).pipe(runPromise);

	const videoBuffer = await downloadVideoContent(freshDownloadUrl);

	if (videoBuffer.length < MINIMUM_VIDEO_SIZE) {
		throw new FatalError(
			`Downloaded file is too small (${videoBuffer.length} bytes). The video may not be available for download.`,
		);
	}

	const uploadResponse = await fetch(presignedPutUrl, {
		method: "PUT",
		body: new Uint8Array(videoBuffer),
		headers: {
			"Content-Type": "video/mp4",
			"Content-Length": videoBuffer.length.toString(),
		},
	});

	if (!uploadResponse.ok) {
		throw new FatalError(
			`Failed to upload to S3: ${uploadResponse.status} ${uploadResponse.statusText}`,
		);
	}

	await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Starting video processing...",
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));

	return {};
}

interface MediaServerProcessResult {
	metadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

const MEDIA_SERVER_START_MAX_ATTEMPTS = 6;
const MEDIA_SERVER_START_RETRY_BASE_MS = 2000;

async function waitForRetry(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function startMediaServerProcessJob(
	mediaServerUrl: string,
	body: {
		videoId: string;
		userId: string;
		videoUrl: string;
		outputPresignedUrl: string;
		thumbnailPresignedUrl: string;
		webhookUrl: string;
		inputExtension?: string;
	},
): Promise<string> {
	for (let attempt = 0; attempt < MEDIA_SERVER_START_MAX_ATTEMPTS; attempt++) {
		const response = await fetch(`${mediaServerUrl}/video/process`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (response.ok) {
			const { jobId } = (await response.json()) as { jobId: string };
			return jobId;
		}

		const errorData = (await response.json().catch(() => ({}))) as {
			error?: string;
			code?: string;
			details?: string;
		};
		const errorMessage =
			errorData.error ||
			errorData.details ||
			"Video processing failed to start";
		const shouldRetry =
			response.status === 503 &&
			(errorData.code === "SERVER_BUSY" ||
				errorMessage.includes("Server is busy"));

		if (shouldRetry && attempt < MEDIA_SERVER_START_MAX_ATTEMPTS - 1) {
			await waitForRetry(MEDIA_SERVER_START_RETRY_BASE_MS * 2 ** attempt);
			continue;
		}

		throw new Error(errorMessage);
	}

	throw new Error("Video processing failed to start");
}

async function processVideoOnMediaServer(
	payload: ImportLoomPayload,
	processingInput: LoomProcessingInput,
): Promise<MediaServerProcessResult> {
	"use step";

	const { videoId, userId, rawFileKey, bucketId } = payload;

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const webhookBaseUrl =
		serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;

	const bucketIdOption = Option.fromNullable(bucketId).pipe(
		Option.map((id) => S3Bucket.S3BucketId.make(id)),
	);

	const { rawVideoUrl, outputPresignedUrl, thumbnailPresignedUrl } =
		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);

			const outputKey = `${userId}/${videoId}/result.mp4`;
			const thumbnailKey = `${userId}/${videoId}/screenshot/screen-capture.jpg`;

			const rawVideoUrl = yield* bucket.getInternalSignedObjectUrl(rawFileKey);

			const outputPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
				outputKey,
				{ ContentType: "video/mp4" },
			);

			const thumbnailPresignedUrl = yield* bucket.getInternalPresignedPutUrl(
				thumbnailKey,
				{
					ContentType: "image/jpeg",
				},
			);

			return { rawVideoUrl, outputPresignedUrl, thumbnailPresignedUrl };
		}).pipe(runPromise);

	const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress`;
	const sourceVideoUrl = processingInput.sourceVideoUrl ?? rawVideoUrl;

	const jobId = await startMediaServerProcessJob(mediaServerUrl, {
		videoId,
		userId,
		videoUrl: sourceVideoUrl,
		outputPresignedUrl,
		thumbnailPresignedUrl,
		webhookUrl,
		inputExtension: processingInput.inputExtension,
	});

	return await pollForCompletion(mediaServerUrl, jobId);
}

async function pollForCompletion(
	mediaServerUrl: string,
	jobId: string,
): Promise<MediaServerProcessResult> {
	const maxAttempts = 360;
	const pollIntervalMs = 5000;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

		const response = await fetch(
			`${mediaServerUrl}/video/process/${jobId}/status`,
			{
				method: "GET",
				headers: { Accept: "application/json" },
			},
		);

		if (!response.ok) continue;

		const status = (await response.json()) as {
			phase: string;
			progress: number;
			error?: string;
			metadata?: {
				duration: number;
				width: number;
				height: number;
				fps: number;
			};
		};

		if (status.phase === "complete") {
			if (!status.metadata) {
				throw new Error("Processing completed but no metadata returned");
			}
			return { metadata: status.metadata };
		}

		if (status.phase === "error") {
			throw new Error(status.error || "Video processing failed");
		}

		if (status.phase === "cancelled") {
			throw new Error("Video processing was cancelled");
		}
	}

	throw new Error("Video processing timed out");
}

async function saveMetadataAndComplete(
	videoId: string,
	metadata: { duration: number; width: number; height: number; fps: number },
): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	await db()
		.delete(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}

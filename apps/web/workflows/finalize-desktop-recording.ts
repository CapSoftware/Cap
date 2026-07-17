import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend";
import { type User, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { FatalError } from "workflow";
import { invalidateGoogleDriveStorageQuotaCache } from "@/lib/google-drive-storage-quota";
import { runPromise } from "@/lib/server";
import { transcribeVideo } from "@/lib/transcribe";
import { decodeStorageVideo } from "@/lib/video-storage";
import { isAiGenerationEnabled } from "@/utils/flags";

interface FinalizeDesktopRecordingWorkflowPayload {
	videoId: string;
	userId: User.UserId;
}

type DesktopSegmentsOutputUpload =
	| {
			type: "put";
			url: string;
	  }
	| {
			type: "multipart";
			videoId: string;
			key: string;
			uploadId: string;
			partSize: number;
			signPartUrl: string;
			completeUrl: string;
			abortUrl: string;
			webhookSecret?: string;
	  };

interface DesktopSegmentsMuxBody {
	videoId: string;
	userId: string;
	outputPresignedUrl: string;
	outputUpload: DesktopSegmentsOutputUpload;
	thumbnailPresignedUrl: string;
	previewGifPresignedUrl: string;
	videoInitUrl: string;
	videoSegmentUrls: string[];
	audioInitUrl?: string;
	audioSegmentUrls?: string[];
	webhookUrl: string;
	webhookSecret?: string;
}

const MEDIA_SERVER_START_MAX_ATTEMPTS = 8;
const MEDIA_SERVER_START_RETRY_BASE_MS = 15_000;
const MEDIA_SERVER_COMPLETION_MAX_ATTEMPTS = 720;
const MEDIA_SERVER_COMPLETION_POLL_INTERVAL_MS = 5_000;
const MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_MULTIPART_OUTPUT_PART_SIZE_BYTES = 64 * 1024 * 1024;

function getRetryDelay(attempt: number) {
	return Math.min(
		MEDIA_SERVER_START_RETRY_BASE_MS * 2 ** attempt,
		5 * 60 * 1000,
	);
}

async function waitForRetry(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitBeforeMuxRetry(delayMs: number): Promise<void> {
	"use step";

	await waitForRetry(delayMs);
}

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function getMediaServerWebhookUrl(baseUrl: string, path: string) {
	const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL(path.replace(/^\//, ""), normalizedBaseUrl).toString();
}

async function abortDesktopSegmentsOutputUpload(
	outputUpload: DesktopSegmentsOutputUpload,
): Promise<void> {
	if (outputUpload.type === "put") return;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (outputUpload.webhookSecret) {
		headers["x-media-server-secret"] = outputUpload.webhookSecret;
	}

	const response = await fetch(outputUpload.abortUrl, {
		method: "POST",
		headers,
		body: JSON.stringify({
			videoId: outputUpload.videoId,
			key: outputUpload.key,
			uploadId: outputUpload.uploadId,
		}),
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		throw new Error(`Failed to abort output upload: ${response.status}`);
	}
}

function isRetryableMuxError(error: unknown) {
	const message = getErrorMessage(error);

	return (
		message.includes("500") ||
		message.includes("502") ||
		message.includes("503") ||
		message.includes("504") ||
		message.includes("429") ||
		message.includes("Application failed to respond") ||
		message.includes("SERVER_BUSY") ||
		message.includes("Server is at capacity") ||
		message.includes("fetch failed") ||
		message.includes("Segment manifest not found") ||
		message.includes("Segment manifest is not marked as complete") ||
		message.includes("timed out") ||
		message.includes("timeout")
	);
}

export async function finalizeDesktopRecordingWorkflow(
	payload: FinalizeDesktopRecordingWorkflowPayload,
): Promise<{ success: true; jobId?: string }> {
	"use workflow";

	const { videoId, userId } = payload;

	try {
		await validateDesktopSegmentsRecording(videoId, userId);

		if (await completeWithoutMediaServerIfUnavailable(videoId)) {
			await queueFinalizedRecordingTranscription(videoId, userId);
			return { success: true };
		}

		for (
			let attempt = 0;
			attempt < MEDIA_SERVER_START_MAX_ATTEMPTS;
			attempt++
		) {
			try {
				await markMuxProcessing(videoId);
				const jobId = await startDesktopSegmentsMuxJob(videoId, userId);
				await waitForDesktopSegmentsMuxCompletion(videoId);
				await queueFinalizedRecordingTranscription(videoId, userId);
				return { success: true, jobId };
			} catch (error) {
				if (
					attempt >= MEDIA_SERVER_START_MAX_ATTEMPTS - 1 ||
					!isRetryableMuxError(error)
				) {
					throw error;
				}

				await markMuxRetrying(videoId, getErrorMessage(error));
				await waitBeforeMuxRetry(getRetryDelay(attempt));

				if (await isDesktopRecordingFinalized(videoId)) {
					await queueFinalizedRecordingTranscription(videoId, userId);
					return { success: true };
				}
			}
		}

		throw new Error("Segment muxing did not complete");
	} catch (error) {
		const errorMessage = getErrorMessage(error);
		await markMuxError(videoId, errorMessage);
		throw new FatalError(errorMessage);
	}
}

async function validateDesktopSegmentsRecording(
	videoId: string,
	userId: User.UserId,
): Promise<void> {
	"use step";

	const [video] = await db()
		.select()
		.from(videos)
		.where(
			and(
				eq(videos.id, Video.VideoId.make(videoId)),
				eq(videos.ownerId, userId),
			),
		);

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	if (video.source?.type === "desktopMP4") {
		return;
	}

	if (video.source?.type !== "desktopSegments") {
		throw new FatalError("Video is not a segmented recording");
	}
}

async function completeWithoutMediaServerIfUnavailable(
	videoId: string,
): Promise<boolean> {
	"use step";

	if (serverEnv().MEDIA_SERVER_URL) {
		return false;
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));

	await db()
		.delete(videoUploads)
		.where(eq(videoUploads.videoId, Video.VideoId.make(videoId)));

	await invalidateGoogleDriveStorageQuotaCache(video?.storageIntegrationId);

	return true;
}

async function markMuxProcessing(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Muxing segments into MP4...",
			processingError: null,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, Video.VideoId.make(videoId)));
}

async function markMuxRetrying(
	videoId: string,
	errorMessage: string,
): Promise<void> {
	"use step";

	await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Retrying segment muxing...",
			processingError: errorMessage,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, Video.VideoId.make(videoId)));
}

async function markMuxError(
	videoId: string,
	errorMessage: string,
): Promise<void> {
	"use step";

	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage: "Segment muxing failed",
			processingError: errorMessage,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, Video.VideoId.make(videoId)));
}

async function isDesktopRecordingFinalized(videoId: string): Promise<boolean> {
	"use step";

	const [video] = await db()
		.select({ source: videos.source })
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));
	const [upload] = await db()
		.select({ videoId: videoUploads.videoId })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, Video.VideoId.make(videoId)));

	return video?.source?.type === "desktopMP4" && !upload;
}

async function buildDesktopSegmentsMuxBody(
	videoId: string,
	userId: User.UserId,
): Promise<DesktopSegmentsMuxBody> {
	const [video] = await db()
		.select()
		.from(videos)
		.where(
			and(
				eq(videos.id, Video.VideoId.make(videoId)),
				eq(videos.ownerId, userId),
			),
		);

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	const segSource = new Video.SegmentsSource({
		videoId,
		ownerId: userId,
	});

	const manifestContent = await bucket
		.getObject(segSource.getManifestKey())
		.pipe(runPromise);
	const manifestJson = Option.getOrNull(manifestContent);

	if (!manifestJson) {
		throw new Error("Segment manifest not found");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestJson);
	} catch {
		throw new Error("Invalid segment manifest JSON");
	}

	let manifest = await Schema.decodeUnknown(Video.SegmentManifest)(parsed)
		.pipe(Effect.mapError(() => new Error("Invalid segment manifest format")))
		.pipe(runPromise);

	if (!manifest.video_init_uploaded || manifest.video_segments.length === 0) {
		throw new Error("No video segments found in manifest");
	}

	if (!manifest.is_complete) {
		manifest = {
			...manifest,
			is_complete: true,
		};
		const body = JSON.stringify(manifest, null, 2);
		await bucket
			.putObject(segSource.getManifestKey(), body, {
				contentType: "application/json",
				contentLength: Buffer.byteLength(body),
			})
			.pipe(runPromise);
	}

	const videoInitUrl = await bucket
		.getSignedObjectUrl(segSource.getVideoInitKey(), {
			expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
		})
		.pipe(runPromise);

	const videoSegmentUrls = await Effect.all(
		manifest.video_segments.map((seg) => {
			const entry = Video.normalizeSegmentEntry(seg);
			return bucket.getSignedObjectUrl(
				segSource.getVideoSegmentKey(entry.index),
				{
					expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
				},
			);
		}),
		{ concurrency: "unbounded" },
	).pipe(runPromise);

	let audioInitUrl: string | undefined;
	let audioSegmentUrls: string[] | undefined;

	if (manifest.audio_init_uploaded && manifest.audio_segments.length > 0) {
		audioInitUrl = await bucket
			.getSignedObjectUrl(segSource.getAudioInitKey(), {
				expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
			})
			.pipe(runPromise);
		audioSegmentUrls = await Effect.all(
			manifest.audio_segments.map((seg) => {
				const entry = Video.normalizeSegmentEntry(seg);
				return bucket.getSignedObjectUrl(
					segSource.getAudioSegmentKey(entry.index),
					{
						expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
					},
				);
			}),
			{ concurrency: "unbounded" },
		).pipe(runPromise);
	}

	const outputKey = `${userId}/${videoId}/result.mp4`;
	const thumbnailKey = `${userId}/${videoId}/screenshot/screen-capture.jpg`;
	const previewGifKey = `${userId}/${videoId}/preview/animated-preview.gif`;
	const env = serverEnv();
	const webhookBaseUrl = env.MEDIA_SERVER_WEBHOOK_URL || env.WEB_URL;
	const webhookSecret = env.MEDIA_SERVER_WEBHOOK_SECRET;

	const outputPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			outputKey,
			{
				ContentType: "video/mp4",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runPromise);
	let outputUpload: DesktopSegmentsOutputUpload = {
		type: "put",
		url: outputPresignedUrl,
	};
	const thumbnailPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			thumbnailKey,
			{
				ContentType: "image/jpeg",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runPromise);
	const previewGifPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			previewGifKey,
			{
				ContentType: "image/gif",
				CacheControl: "public, max-age=31536000, immutable",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runPromise);

	if (bucket.provider === "s3" && webhookSecret) {
		try {
			const signPartUrl = getMediaServerWebhookUrl(
				webhookBaseUrl,
				"/api/webhooks/media-server/multipart/sign-part",
			);
			const completeUrl = getMediaServerWebhookUrl(
				webhookBaseUrl,
				"/api/webhooks/media-server/multipart/complete",
			);
			const abortUrl = getMediaServerWebhookUrl(
				webhookBaseUrl,
				"/api/webhooks/media-server/multipart/abort",
			);
			const multipartUpload = await bucket.multipart
				.create(outputKey, { ContentType: "video/mp4" })
				.pipe(runPromise);
			if (!multipartUpload.UploadId) {
				throw new Error("Storage did not return a multipart upload id");
			}
			outputUpload = {
				type: "multipart",
				videoId,
				key: outputKey,
				uploadId: multipartUpload.UploadId,
				partSize: MEDIA_SERVER_MULTIPART_OUTPUT_PART_SIZE_BYTES,
				signPartUrl,
				completeUrl,
				abortUrl,
				webhookSecret: webhookSecret || undefined,
			};
		} catch (error) {
			console.warn(
				`[finalizeDesktopRecordingWorkflow] Failed to create multipart output upload for ${videoId}:`,
				error,
			);
		}
	}

	return {
		videoId,
		userId,
		outputPresignedUrl,
		outputUpload,
		thumbnailPresignedUrl,
		previewGifPresignedUrl,
		videoInitUrl,
		videoSegmentUrls,
		audioInitUrl,
		audioSegmentUrls,
		webhookUrl: `${webhookBaseUrl}/api/webhooks/media-server/progress?retryable=true`,
		webhookSecret: webhookSecret || undefined,
	};
}

async function startDesktopSegmentsMuxJob(
	videoId: string,
	userId: User.UserId,
): Promise<string> {
	"use step";

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const body = await buildDesktopSegmentsMuxBody(videoId, userId);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (body.webhookSecret) {
		headers["x-media-server-secret"] = body.webhookSecret;
	}

	let response: Response;
	try {
		response = await fetch(`${mediaServerUrl}/video/mux-segments`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (error) {
		await abortDesktopSegmentsOutputUpload(body.outputUpload).catch(
			(abortError) => {
				console.warn(
					`[finalizeDesktopRecordingWorkflow] Failed to abort output upload for ${videoId}:`,
					abortError,
				);
			},
		);
		throw error;
	}

	if (!response.ok) {
		await abortDesktopSegmentsOutputUpload(body.outputUpload).catch(
			(abortError) => {
				console.warn(
					`[finalizeDesktopRecordingWorkflow] Failed to abort output upload for ${videoId}:`,
					abortError,
				);
			},
		);
		const errorText = await response.text().catch(() => "");
		throw new Error(
			`Failed to start segment muxing: ${response.status} ${errorText}`,
		);
	}

	const result = (await response.json()) as { jobId?: string };
	if (!result.jobId) {
		throw new Error("Media server did not return a mux job id");
	}

	return result.jobId;
}

async function waitForDesktopSegmentsMuxCompletion(
	videoId: string,
): Promise<void> {
	"use step";

	let lastStatus = "processing";

	for (
		let attempt = 0;
		attempt < MEDIA_SERVER_COMPLETION_MAX_ATTEMPTS;
		attempt++
	) {
		await waitForRetry(MEDIA_SERVER_COMPLETION_POLL_INTERVAL_MS);

		const [video] = await db()
			.select({ source: videos.source })
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(videoId)));
		const [upload] = await db()
			.select({
				phase: videoUploads.phase,
				processingProgress: videoUploads.processingProgress,
				processingMessage: videoUploads.processingMessage,
				processingError: videoUploads.processingError,
			})
			.from(videoUploads)
			.where(eq(videoUploads.videoId, Video.VideoId.make(videoId)));

		if (video?.source?.type === "desktopMP4" && !upload) {
			return;
		}

		if (!upload) {
			const [currentVideo] = await db()
				.select({ source: videos.source })
				.from(videos)
				.where(eq(videos.id, Video.VideoId.make(videoId)));

			if (currentVideo?.source?.type === "desktopMP4") {
				return;
			}

			throw new Error("Segment muxing state disappeared before completion");
		}

		if (upload.processingError) {
			throw new Error(upload.processingError);
		}

		if (upload.phase === "error") {
			throw new Error(upload.processingMessage || "Segment muxing failed");
		}

		if (upload.phase === "complete") {
			return;
		}

		lastStatus = [
			upload.phase,
			typeof upload.processingProgress === "number"
				? `${upload.processingProgress}%`
				: null,
			upload.processingMessage,
		]
			.filter(Boolean)
			.join(" ");
	}

	throw new Error(`Segment muxing timed out while ${lastStatus}`);
}

async function queueFinalizedRecordingTranscription(
	videoId: string,
	userId: User.UserId,
): Promise<void> {
	"use step";

	const [owner] = await db()
		.select({
			email: users.email,
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(users)
		.where(eq(users.id, userId));

	const aiGenerationEnabled = owner
		? await isAiGenerationEnabled(owner)
		: false;

	const result = await transcribeVideo(
		Video.VideoId.make(videoId),
		userId,
		aiGenerationEnabled,
	);

	if (!result.success) {
		console.warn(
			"[finalizeDesktopRecordingWorkflow] Failed to queue transcription",
			{
				videoId,
				message: result.message,
			},
		);
	}
}

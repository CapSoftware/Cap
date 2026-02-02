import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import { organizations, s3Buckets, users, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { createClient } from "@deepgram/sdk";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { FatalError } from "workflow";
import {
	ENHANCED_AUDIO_CONTENT_TYPE,
	ENHANCED_AUDIO_EXTENSION,
	enhanceAudioFromUrl,
	isAudioEnhancementConfigured,
} from "@/lib/audio-enhance";
import { checkHasAudioTrack, extractAudioFromUrl } from "@/lib/audio-extract";
import { startAiGeneration } from "@/lib/generate-ai";
import {
	checkHasAudioTrackViaMediaServer,
	extractAudioViaMediaServer,
	isMediaServerConfigured,
} from "@/lib/media-client";
import { runPromise } from "@/lib/server";
import { type DeepgramResult, formatToWebVTT } from "@/lib/transcribe-utils";

interface TranscribeWorkflowPayload {
	videoId: string;
	userId: string;
	aiGenerationEnabled: boolean;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	bucketId: S3Bucket.S3BucketId | null;
	transcriptionDisabled: boolean;
	isOwnerPro: boolean;
}

export async function transcribeVideoWorkflow(
	payload: TranscribeWorkflowPayload,
) {
	"use workflow";

	const { videoId, userId, aiGenerationEnabled } = payload;

	const videoData = await validateVideo(videoId);

	if (videoData.transcriptionDisabled) {
		await markSkipped(videoId);
		return { success: true, message: "Transcription disabled - skipped" };
	}

	const audioUrl = await extractAudio(videoId, userId, videoData.bucketId);

	if (!audioUrl) {
		await markNoAudio(videoId);
		return {
			success: true,
			message: "Video has no audio track - skipped transcription",
		};
	}

	const enhancementConfigured = isAudioEnhancementConfigured();
	const shouldEnhanceAudio = videoData.isOwnerPro && enhancementConfigured;

	console.log(
		`[transcribe] Audio enhancement check: isOwnerPro=${videoData.isOwnerPro}, configured=${enhancementConfigured}, shouldEnhance=${shouldEnhanceAudio}`,
	);

	if (shouldEnhanceAudio) {
		await markEnhancedAudioProcessing(videoId);
	}

	const [transcription] = await Promise.all([
		transcribeWithDeepgram(audioUrl),
		shouldEnhanceAudio
			? enhanceAndSaveAudio(videoId, userId, audioUrl, videoData.bucketId)
			: Promise.resolve(),
	]);

	await saveTranscription(videoId, userId, videoData.bucketId, transcription);

	await cleanupTempAudio(videoId, userId, videoData.bucketId);

	if (aiGenerationEnabled) {
		await queueAiGeneration(videoId, userId);
	}

	return { success: true, message: "Transcription completed successfully" };
}

async function validateVideo(videoId: string): Promise<VideoData> {
	"use step";

	if (!serverEnv().DEEPGRAM_API_KEY) {
		throw new FatalError("Missing DEEPGRAM_API_KEY");
	}

	const query = await db()
		.select({
			video: videos,
			bucket: s3Buckets,
			settings: videos.settings,
			orgSettings: organizations.settings,
			owner: users,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.innerJoin(users, eq(videos.ownerId, users.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0) {
		throw new FatalError("Video does not exist");
	}

	const result = query[0];
	if (!result?.video) {
		throw new FatalError("Video information is missing");
	}

	const transcriptionDisabled =
		result.video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript ??
		false;

	const isOwnerPro = userIsPro(result.owner);

	console.log(
		`[transcribe] Owner check: stripeSubscriptionStatus=${result.owner.stripeSubscriptionStatus}, thirdPartyStripeSubscriptionId=${result.owner.thirdPartyStripeSubscriptionId}, isOwnerPro=${isOwnerPro}`,
	);

	await db()
		.update(videos)
		.set({ transcriptionStatus: "PROCESSING" })
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video: result.video,
		bucketId: (result.bucket?.id ?? null) as S3Bucket.S3BucketId | null,
		transcriptionDisabled,
		isOwnerPro,
	};
}

async function markSkipped(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "SKIPPED" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function markNoAudio(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "NO_AUDIO" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function extractAudio(
	videoId: string,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<string | null> {
	"use step";

	const [bucket] = await S3Buckets.getBucketAccess(
		Option.fromNullable(bucketId),
	).pipe(runPromise);

	const videoKey = `${userId}/${videoId}/result.mp4`;
	const videoUrl = await bucket.getSignedObjectUrl(videoKey).pipe(runPromise);

	const response = await fetch(videoUrl, {
		method: "GET",
		headers: { range: "bytes=0-0" },
	});
	if (!response.ok) {
		throw new Error("Video file not accessible");
	}

	const useMediaServer = isMediaServerConfigured();

	let hasAudio: boolean;
	let audioBuffer: Buffer;

	if (useMediaServer) {
		hasAudio = await checkHasAudioTrackViaMediaServer(videoUrl);
		if (!hasAudio) {
			return null;
		}

		audioBuffer = await extractAudioViaMediaServer(videoUrl);
	} else {
		hasAudio = await checkHasAudioTrack(videoUrl);
		if (!hasAudio) {
			return null;
		}

		const result = await extractAudioFromUrl(videoUrl);

		try {
			audioBuffer = await fs.readFile(result.filePath);
		} finally {
			await result.cleanup();
		}
	}

	const audioKey = `${userId}/${videoId}/audio-temp.mp3`;

	await bucket
		.putObject(audioKey, audioBuffer, {
			contentType: "audio/mpeg",
		})
		.pipe(runPromise);

	const audioSignedUrl = await bucket
		.getSignedObjectUrl(audioKey)
		.pipe(runPromise);

	return audioSignedUrl;
}

async function transcribeWithDeepgram(audioUrl: string): Promise<string> {
	"use step";

	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}

	const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

	const deepgram = createClient(serverEnv().DEEPGRAM_API_KEY as string);

	const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
		audioBuffer,
		{
			model: "nova-3",
			smart_format: true,
			detect_language: true,
			utterances: true,
			mime_type: "audio/mpeg",
		},
	);

	if (error) {
		throw new Error(`Deepgram transcription failed: ${error.message}`);
	}

	return formatToWebVTT(result as unknown as DeepgramResult);
}

async function saveTranscription(
	videoId: string,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
	transcription: string,
): Promise<void> {
	"use step";

	const [bucket] = await S3Buckets.getBucketAccess(
		Option.fromNullable(bucketId),
	).pipe(runPromise);

	await bucket
		.putObject(`${userId}/${videoId}/transcription.vtt`, transcription, {
			contentType: "text/vtt",
		})
		.pipe(runPromise);

	await db()
		.update(videos)
		.set({ transcriptionStatus: "COMPLETE" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function cleanupTempAudio(
	videoId: string,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<void> {
	"use step";

	const audioKey = `${userId}/${videoId}/audio-temp.mp3`;

	try {
		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId),
		).pipe(runPromise);

		await bucket.deleteObject(audioKey).pipe(runPromise);
	} catch (error) {
		console.error(
			`[transcribe] Failed to cleanup temp audio file: ${audioKey}`,
			error,
		);
	}
}

async function queueAiGeneration(
	videoId: string,
	userId: string,
): Promise<void> {
	"use step";

	await startAiGeneration(videoId as Video.VideoId, userId);
}

async function markEnhancedAudioProcessing(videoId: string): Promise<void> {
	"use step";

	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	const currentMetadata = (video?.metadata as VideoMetadata) || {};

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				enhancedAudioStatus: "PROCESSING",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function enhanceAndSaveAudio(
	videoId: string,
	userId: string,
	audioUrl: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<void> {
	"use step";

	console.log(`[transcribe] Starting audio enhancement for video ${videoId}`);

	try {
		const enhancedBuffer = await enhanceAudioFromUrl(audioUrl);
		console.log(
			`[transcribe] Audio enhanced, saving to S3 (${enhancedBuffer.length} bytes)`,
		);

		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId),
		).pipe(runPromise);

		const enhancedAudioKey = `${userId}/${videoId}/enhanced-audio.${ENHANCED_AUDIO_EXTENSION}`;

		await bucket
			.putObject(enhancedAudioKey, enhancedBuffer, {
				contentType: ENHANCED_AUDIO_CONTENT_TYPE,
			})
			.pipe(runPromise);

		const [video] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (video?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "COMPLETE",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	} catch (error) {
		console.error(
			`[transcribe] Audio enhancement failed for video ${videoId}:`,
			error,
		);

		const [video] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (video?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	}
}

import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import { organizations, s3Buckets, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { createClient } from "@deepgram/sdk";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { FatalError } from "workflow";
import { generateAiMetadata } from "@/actions/videos/generate-ai-metadata";
import { checkHasAudioTrack, extractAudioFromUrl } from "@/lib/audio-extract";
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
}

export async function transcribeVideoWorkflow(
	payload: TranscribeWorkflowPayload,
) {
	"use workflow";

	const { videoId, userId, aiGenerationEnabled } = payload;

	console.log(`[transcribe-workflow] Starting for video ${videoId}`);

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

	const transcription = await transcribeWithDeepgram(audioUrl);

	await saveTranscription(videoId, userId, videoData.bucketId, transcription);

	await cleanupTempAudio(videoId, userId, videoData.bucketId);

	if (aiGenerationEnabled) {
		await generateMetadata(videoId, userId);
	}

	console.log(`[transcribe-workflow] Completed for video ${videoId}`);
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
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
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

	await db()
		.update(videos)
		.set({ transcriptionStatus: "PROCESSING" })
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video: result.video,
		bucketId: (result.bucket?.id ?? null) as S3Bucket.S3BucketId | null,
		transcriptionDisabled,
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

	console.log(`[transcribe-workflow] Video ${videoId} has no audio track`);
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

	const hasAudio = await checkHasAudioTrack(videoUrl);
	if (!hasAudio) {
		console.log("[transcribe-workflow] Video has no audio track");
		return null;
	}

	console.log("[transcribe-workflow] Extracting audio from video");
	const result = await extractAudioFromUrl(videoUrl);

	try {
		const audioBuffer = await fs.readFile(result.filePath);
		const audioKey = `${userId}/${videoId}/audio-temp.m4a`;

		await bucket
			.putObject(audioKey, audioBuffer, {
				contentType: result.mimeType,
			})
			.pipe(runPromise);

		const audioSignedUrl = await bucket
			.getSignedObjectUrl(audioKey)
			.pipe(runPromise);

		console.log("[transcribe-workflow] Audio uploaded to S3");
		return audioSignedUrl;
	} finally {
		await result.cleanup();
	}
}

async function transcribeWithDeepgram(audioUrl: string): Promise<string> {
	"use step";

	console.log("[transcribe-workflow] Calling Deepgram API");
	const deepgram = createClient(serverEnv().DEEPGRAM_API_KEY as string);

	const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
		{ url: audioUrl },
		{
			model: "nova-3",
			smart_format: true,
			detect_language: true,
			utterances: true,
			mime_type: "audio/mp4",
		},
	);

	if (error) {
		console.error("[transcribe-workflow] Deepgram error:", error);
		throw new Error(`Deepgram transcription failed: ${error.message}`);
	}

	console.log("[transcribe-workflow] Transcription received");
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

	console.log("[transcribe-workflow] Transcription saved to S3");
}

async function cleanupTempAudio(
	videoId: string,
	userId: string,
	bucketId: S3Bucket.S3BucketId | null,
): Promise<void> {
	"use step";

	try {
		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId),
		).pipe(runPromise);

		const audioKey = `${userId}/${videoId}/audio-temp.m4a`;
		await bucket.deleteObject(audioKey).pipe(runPromise);
		console.log("[transcribe-workflow] Cleaned up temp audio file");
	} catch {}
}

async function generateMetadata(
	videoId: string,
	userId: string,
): Promise<void> {
	"use step";

	console.log("[transcribe-workflow] Triggering AI metadata generation");
	await generateAiMetadata(videoId as Video.VideoId, userId);
}

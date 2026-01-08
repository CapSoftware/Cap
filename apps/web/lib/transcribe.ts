import { db } from "@cap/database";
import { organizations, s3Buckets, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";

type TranscribeResult = {
	success: boolean;
	message: string;
};

export async function transcribeVideo(
	videoId: Video.VideoId,
	userId: string,
	aiGenerationEnabled = false,
	_isRetry = false,
): Promise<TranscribeResult> {
	if (!serverEnv().DEEPGRAM_API_KEY) {
		return {
			success: false,
			message: "Missing necessary environment variables",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
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
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return { success: false, message: "Video does not exist" };
	}

	const result = query[0];
	if (!result || !result.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;

	if (!video) {
		return { success: false, message: "Video information is missing" };
	}

	if (
		video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript
	) {
		console.log(
			`[transcribeVideo] Transcription disabled for video ${videoId}`,
		);
		try {
			await db()
				.update(videos)
				.set({ transcriptionStatus: "SKIPPED" })
				.where(eq(videos.id, videoId));
		} catch (err) {
			console.error(`[transcribeVideo] Failed to mark as skipped:`, err);
			return {
				success: false,
				message: "Transcription disabled, but failed to update status",
			};
		}
		return {
			success: true,
			message: "Transcription disabled for video — skipping transcription",
		};
	}

	if (
		video.transcriptionStatus === "COMPLETE" ||
		video.transcriptionStatus === "PROCESSING"
	) {
		return {
			success: true,
			message: "Transcription already completed or in progress",
		};
	}

	try {
		console.log(
			`[transcribeVideo] Triggering transcription workflow for video ${videoId}`,
		);

		await start(transcribeVideoWorkflow, [
			{
				videoId,
				userId,
				aiGenerationEnabled,
			},
		]);

		return {
			success: true,
			message: "Transcription workflow started",
		};
	} catch (error) {
		console.error("[transcribeVideo] Failed to trigger workflow:", error);

		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId));

		return {
			success: false,
			message: "Failed to start transcription workflow",
		};
	}
}

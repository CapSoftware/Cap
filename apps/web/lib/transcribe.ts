import { db } from "@cap/database";
import {
	organizations,
	s3Buckets,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { runTranscription } from "@/workflows/transcribe";

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
		video.transcriptionStatus === "PROCESSING" ||
		video.transcriptionStatus === "SKIPPED" ||
		video.transcriptionStatus === "NO_AUDIO"
	) {
		return {
			success: true,
			message: "Transcription already completed or in progress",
		};
	}

	const upload = await db()
		.select({ phase: videoUploads.phase })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId))
		.limit(1);

	if (
		upload[0]?.phase === "uploading" ||
		upload[0]?.phase === "processing" ||
		upload[0]?.phase === "generating_thumbnail"
	) {
		console.log(
			`[transcribeVideo] Video ${videoId} upload still in progress (phase=${upload[0]?.phase}), skipping`,
		);
		return {
			success: true,
			message: "Video upload is still in progress",
		};
	}

	try {
		await db()
			.update(videos)
			.set({ transcriptionStatus: "PROCESSING" })
			.where(eq(videos.id, videoId));

		console.log(
			`[transcribeVideo] Starting transcription directly for video ${videoId}`,
		);

		runTranscription({ videoId, userId, aiGenerationEnabled })
			.then(() => {
				console.log(
					`[transcribeVideo] Transcription completed for video ${videoId}`,
				);
			})
			.catch((error) => {
				console.error(
					`[transcribeVideo] Transcription failed for video ${videoId}:`,
					error,
				);
				db()
					.update(videos)
					.set({ transcriptionStatus: null })
					.where(eq(videos.id, videoId))
					.catch((err) =>
						console.error(
							`[transcribeVideo] Failed to reset status for ${videoId}:`,
							err,
						),
					);
			});

		return {
			success: true,
			message: "Transcription started",
		};
	} catch (error) {
		console.error("[transcribeVideo] Failed to start transcription:", error);

		return {
			success: false,
			message: "Failed to start transcription",
		};
	}
}

import { db } from "@cap/database";
import { organizations, videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { start } from "workflow/api";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";

type TranscribeResult = {
	success: boolean;
	message: string;
};

const TRANSCRIPTION_ALREADY_HANDLED_MESSAGE =
	"Transcription already completed, in progress, or awaiting manual retry";

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export async function transcribeVideo(
	videoId: Video.VideoId,
	userId: string,
	aiGenerationEnabled = false,
): Promise<TranscribeResult> {
	if (!serverEnv().ASSEMBLY_API_KEY) {
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
			settings: videos.settings,
			orgSettings: organizations.settings,
		})
		.from(videos)
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
		video.transcriptionStatus === "NO_AUDIO" ||
		video.transcriptionStatus === "ERROR"
	) {
		return {
			success: true,
			message: TRANSCRIPTION_ALREADY_HANDLED_MESSAGE,
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
		return {
			success: true,
			message: "Video upload is still in progress",
		};
	}

	try {
		const transitionResult = await db()
			.update(videos)
			.set({ transcriptionStatus: "PROCESSING" })
			.where(and(eq(videos.id, videoId), isNull(videos.transcriptionStatus)));

		if (getAffectedRows(transitionResult) === 0) {
			return {
				success: true,
				message: TRANSCRIPTION_ALREADY_HANDLED_MESSAGE,
			};
		}

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

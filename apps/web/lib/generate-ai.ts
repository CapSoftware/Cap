import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { start } from "workflow/api";
import { generateAiWorkflow } from "@/workflows/generate-ai";

type GenerateAiResult = {
	success: boolean;
	message: string;
};

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export async function startAiGeneration(
	videoId: Video.VideoId,
	userId: string,
): Promise<GenerateAiResult> {
	if (!serverEnv().GROQ_API_KEY && !serverEnv().OPENAI_API_KEY) {
		return {
			success: false,
			message: "Missing AI API keys (Groq or OpenAI)",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		return { success: false, message: "Video does not exist" };
	}

	const { video } = query[0];

	if (video.transcriptionStatus !== "COMPLETE") {
		return {
			success: false,
			message: "Transcription not complete",
		};
	}

	const metadata = (video.metadata as VideoMetadata) || {};

	if (
		metadata.aiGenerationStatus === "PROCESSING" ||
		metadata.aiGenerationStatus === "QUEUED"
	) {
		return {
			success: true,
			message: "AI generation already in progress",
		};
	}

	if (
		metadata.aiGenerationStatus === "COMPLETE" &&
		metadata.summary &&
		metadata.chapters
	) {
		return {
			success: true,
			message: "AI metadata already generated",
		};
	}

	try {
		const transitionResult = await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "QUEUED",
				},
			})
			.where(
				and(
					eq(videos.id, videoId),
					eq(videos.updatedAt, video.updatedAt),
					eq(videos.transcriptionStatus, "COMPLETE"),
				),
			);

		if (getAffectedRows(transitionResult) === 0) {
			return {
				success: true,
				message: "AI generation already in progress",
			};
		}

		await start(generateAiWorkflow, [{ videoId, userId }]);

		return {
			success: true,
			message: "AI generation workflow started",
		};
	} catch {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'ERROR')`,
			})
			.where(
				and(
					eq(videos.id, videoId),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) = 'QUEUED'`,
				),
			);

		return {
			success: false,
			message: "Failed to start AI generation workflow",
		};
	}
}

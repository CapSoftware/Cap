import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { generateAiWorkflow } from "@/workflows/generate-ai";

type GenerateAiResult = {
	success: boolean;
	message: string;
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
		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "QUEUED",
				},
			})
			.where(eq(videos.id, videoId));

		await start(generateAiWorkflow, [{ videoId, userId }]);

		return {
			success: true,
			message: "AI generation workflow started",
		};
	} catch {
		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId));

		return {
			success: false,
			message: "Failed to start AI generation workflow",
		};
	}
}

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { startAiGeneration } from "@/lib/generate-ai";
import { isAiGenerationEnabled } from "@/utils/flags";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	try {
		const user = await getCurrentUser();
		const url = new URL(request.url);
		const videoId = url.searchParams.get("videoId") as Video.VideoId;

		if (!user) {
			return Response.json({ auth: false }, { status: 401 });
		}

		if (!videoId) {
			return Response.json(
				{ error: true, message: "Video ID not provided" },
				{ status: 400 },
			);
		}

		const result = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId));
		if (result.length === 0 || !result[0]) {
			return Response.json(
				{ error: true, message: "Video not found" },
				{ status: 404 },
			);
		}

		const video = result[0];
		const metadata: VideoMetadata = (video.metadata as VideoMetadata) || {};

		if (metadata.summary || metadata.chapters) {
			console.log(
				`[AI API] Returning existing AI metadata for video ${videoId}`,
			);
			return Response.json(
				{
					processing: false,
					title: metadata.aiTitle ?? null,
					summary: metadata.summary ?? null,
					chapters: metadata.chapters ?? null,
					aiGenerationStatus: metadata.aiGenerationStatus ?? null,
				},
				{ status: 200 },
			);
		}

		if (
			metadata.aiGenerationStatus === "PROCESSING" ||
			metadata.aiGenerationStatus === "QUEUED"
		) {
			console.log(
				`[AI API] AI processing already in progress for video ${videoId}`,
			);
			return Response.json(
				{
					processing: true,
					message: "AI metadata generation in progress",
					aiGenerationStatus: metadata.aiGenerationStatus,
				},
				{ status: 200 },
			);
		}

		const canRetry =
			metadata.aiGenerationStatus === "ERROR" ||
			metadata.aiGenerationStatus === "SKIPPED";

		if (!canRetry) {
			return Response.json(
				{
					processing: false,
					message:
						"AI generation is not available for retry. Generation is triggered automatically when transcription completes.",
					aiGenerationStatus: metadata.aiGenerationStatus ?? null,
				},
				{ status: 200 },
			);
		}

		if (video.transcriptionStatus !== "COMPLETE") {
			return Response.json(
				{
					processing: false,
					message: `Cannot generate AI metadata - transcription status: ${video.transcriptionStatus || "unknown"}`,
					aiGenerationStatus: metadata.aiGenerationStatus ?? null,
				},
				{ status: 200 },
			);
		}

		const videoOwnerQuery = await db()
			.select({
				email: users.email,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(users)
			.where(eq(users.id, video.ownerId))
			.limit(1);

		if (
			videoOwnerQuery.length === 0 ||
			!videoOwnerQuery[0] ||
			!(await isAiGenerationEnabled(videoOwnerQuery[0]))
		) {
			return Response.json(
				{
					processing: false,
					message: "AI generation feature is not available for this user",
				},
				{ status: 403 },
			);
		}

		try {
			const aiResult = await startAiGeneration(videoId, video.ownerId);

			if (!aiResult.success) {
				return Response.json(
					{
						processing: false,
						error: aiResult.message,
					},
					{ status: 500 },
				);
			}

			return Response.json(
				{
					processing: true,
					message: aiResult.message,
					aiGenerationStatus: "QUEUED",
				},
				{ status: 200 },
			);
		} catch (error) {
			console.error("[AI API] Error starting AI generation workflow:", error);
			return Response.json(
				{
					processing: false,
					error: "Failed to start AI generation workflow",
				},
				{ status: 500 },
			);
		}
	} catch (error) {
		console.error("[AI API] Unexpected error:", error);
		return Response.json(
			{
				processing: false,
				error: "An unexpected error occurred",
			},
			{ status: 500 },
		);
	}
}

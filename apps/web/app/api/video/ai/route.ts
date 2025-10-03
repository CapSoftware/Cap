import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { generateAiMetadata } from "@/actions/videos/generate-ai-metadata";
import { isAiGenerationEnabled } from "@/utils/flags";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	try {
		const user = await getCurrentUser();
		const url = new URL(request.url);
		const videoId = url.searchParams.get("videoId");

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

		// If we have AI data, return it
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
				},
				{ status: 200 },
			);
		}

		if (metadata.aiProcessing) {
			console.log(
				`[AI API] AI processing already in progress for video ${videoId}`,
			);
			return Response.json(
				{
					processing: true,
					message: "AI metadata generation in progress",
				},
				{ status: 200 },
			);
		}

		if (video.transcriptionStatus !== "COMPLETE") {
			return Response.json(
				{
					processing: false,
					message: `Cannot generate AI metadata - transcription status: ${video.transcriptionStatus || "unknown"}`,
				},
				{ status: 200 },
			);
		}

		const videoOwnerQuery = await db()
			.select({
				email: users.email,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			})
			.from(users)
			.where(eq(users.id, video.ownerId))
			.limit(1);

		if (
			videoOwnerQuery.length === 0 ||
			!videoOwnerQuery[0] ||
			!(await isAiGenerationEnabled(videoOwnerQuery[0]))
		) {
			const videoOwner = videoOwnerQuery[0];
			return Response.json(
				{
					processing: false,
					message: "AI generation feature is not available for this user",
				},
				{ status: 403 },
			);
		}

		try {
			generateAiMetadata(videoId, video.ownerId).catch((error) => {
				console.error("[AI API] Error generating AI metadata:", error);
			});

			return Response.json(
				{
					processing: true,
					message: "AI metadata generation started",
				},
				{ status: 200 },
			);
		} catch (error) {
			console.error("[AI API] Error starting AI metadata generation:", error);
			return Response.json(
				{
					processing: false,
					error: "Failed to start AI metadata generation",
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

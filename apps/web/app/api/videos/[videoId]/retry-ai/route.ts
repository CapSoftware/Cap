import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { startAiGeneration } from "@/lib/generate-ai";
import { isAiGenerationEnabled } from "@/utils/flags";

export async function POST(
	_request: Request,
	props: RouteContext<"/api/videos/[videoId]/retry-ai">,
) {
	try {
		const user = await getCurrentUser();
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { videoId } = (await props.params) as { videoId: Video.VideoId };
		if (!videoId) {
			return Response.json({ error: "Video ID is required" }, { status: 400 });
		}

		const videoQuery = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);

		if (videoQuery.length === 0 || !videoQuery[0]) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}

		const video = videoQuery[0];
		if (video.ownerId !== user.id) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		if (video.transcriptionStatus !== "COMPLETE") {
			return Response.json(
				{
					error: "Cannot generate AI metadata - transcription is not complete",
					transcriptionStatus: video.transcriptionStatus,
				},
				{ status: 400 },
			);
		}

		const metadata = (video.metadata as VideoMetadata) || {};

		const canRetry =
			!metadata.aiGenerationStatus ||
			metadata.aiGenerationStatus === "ERROR" ||
			metadata.aiGenerationStatus === "SKIPPED";

		if (!canRetry) {
			return Response.json(
				{
					error:
						"AI generation is already in progress or completed. Cannot retry.",
					aiGenerationStatus: metadata.aiGenerationStatus,
				},
				{ status: 400 },
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
					error: "AI generation feature is not available for this user",
				},
				{ status: 403 },
			);
		}

		const result = await startAiGeneration(videoId, video.ownerId);

		if (!result.success) {
			return Response.json({ error: result.message }, { status: 500 });
		}

		revalidatePath(`/s/${videoId}`);

		return Response.json({
			success: true,
			message: result.message,
		});
	} catch (error) {
		console.error("Error retrying AI generation:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}

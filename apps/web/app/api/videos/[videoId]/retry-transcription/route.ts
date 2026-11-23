import { db } from "@cap/database";
import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	PROCESSING_RETRY_RATE_MESSAGE,
	processingRetryLimited,
} from "@/lib/processing-retry-limit";

export async function POST(
	request: Request,
	props: RouteContext<"/api/videos/[videoId]/retry-transcription">,
) {
	try {
		const user = isCrossSiteCookieWrite(request)
			? null
			: await getCurrentUser();
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { videoId } = (await props.params) as { videoId: Video.VideoId };
		if (!videoId) {
			return Response.json({ error: "Video ID is required" }, { status: 400 });
		}

		// Verify user owns the video
		const videoQuery = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);

		if (videoQuery.length === 0) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}

		const video = videoQuery[0];
		if (!video || video.ownerId !== user.id) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		if (await processingRetryLimited(user.id, request.headers)) {
			return Response.json(
				{ error: PROCESSING_RETRY_RATE_MESSAGE },
				{ status: 429 },
			);
		}

		// Reset status to null - this will trigger automatic retry via get-status.ts
		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId));

		// Revalidate the video page to ensure UI updates with fresh data
		revalidatePath(`/s/${videoId}`);

		return Response.json({
			success: true,
			message: "Transcription retry triggered",
		});
	} catch (error) {
		console.error("Error resetting transcription status:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}

import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { eq } from "drizzle-orm";
import { transcribeVideo } from "@/lib/transcribe";

export async function POST(request: Request) {
	try {
		const user = await getCurrentUser();
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { videoId } = await request.json();
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

		// Reset status to allow retry
		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId));

		// Trigger transcription with retry flag
		const result = await transcribeVideo(videoId, user.id, false, true);

		return Response.json(result);
	} catch (error) {
		console.error("Error retrying transcription:", error);
		return Response.json(
			{ error: "Internal server error" },
			{ status: 500 }
		);
	}
}

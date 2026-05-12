"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export async function getTranscript(
	videoId: Video.VideoId,
): Promise<{ success: boolean; content?: string; message: string }> {
	const user = await getCurrentUser();

	if (!videoId) {
		return {
			success: false,
			message: "Missing required data for fetching transcript",
		};
	}

	const query = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return { success: false, message: "Video not found" };
	}

	const result = query[0];
	if (!result?.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;

	if (video.transcriptionStatus !== "COMPLETE") {
		return {
			success: false,
			message: "Transcript is not ready yet",
		};
	}

	try {
		const vttContent = await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
			);

			return yield* bucket.getObject(
				`${video.ownerId}/${videoId}/transcription.vtt`,
			);
		}).pipe(runPromise);

		if (Option.isNone(vttContent)) {
			return { success: false, message: "Transcript file not found" };
		}

		return {
			success: true,
			content: vttContent.value,
			message: "Transcript retrieved successfully",
		};
	} catch (error) {
		console.error("[getTranscript] Error fetching transcript:", {
			error: error instanceof Error ? error.message : error,
			videoId,
			userId: user?.id,
		});
		return {
			success: false,
			message: "Failed to fetch transcript",
		};
	}
}

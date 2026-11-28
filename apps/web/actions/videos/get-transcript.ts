"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { provideOptionalAuth, Storage, VideosPolicy } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import * as EffectRuntime from "@/lib/server";
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

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;
		const [video] = yield* Effect.promise(() =>
			db().select().from(videos).where(eq(videos.id, videoId)),
		);

		if (video) {
			yield* videosPolicy.canViewLoaded(
				video,
				Option.fromNullable(video.password),
			);
		}

		return video;
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit) || !exit.value) {
		return { success: false, message: "Video not found" };
	}

	const video = exit.value;

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

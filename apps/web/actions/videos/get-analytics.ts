"use server";

import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Policy, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import * as EffectRuntime from "@/lib/server";
import {
	getVideoViewCount,
	type VideoViewCountOptions,
} from "@/lib/video-view-count";

export async function getVideoAnalytics(
	videoId: string,
	options?: VideoViewCountOptions,
) {
	if (!videoId) throw new Error("Video ID is required");

	const id = Video.VideoId.make(videoId);

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;
		return yield* Effect.promise(() =>
			db()
				.select({ id: videos.id })
				.from(videos)
				.where(eq(videos.id, id))
				.limit(1),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(id)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit) || !exit.value[0]) {
		throw new Error("Video not found");
	}

	return getVideoViewCount(videoId, options);
}

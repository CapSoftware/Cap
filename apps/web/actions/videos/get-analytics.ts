"use server";

import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
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
		const [video] = yield* Effect.promise(() =>
			db()
				.select({
					id: videos.id,
					ownerId: videos.ownerId,
					orgId: videos.orgId,
					public: videos.public,
					password: videos.password,
				})
				.from(videos)
				.where(eq(videos.id, id))
				.limit(1),
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
		throw new Error("Video not found");
	}

	return getVideoViewCount(videoId, options);
}

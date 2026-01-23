"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { s3Buckets, videos } from "@inflight/database/schema";
import { S3Buckets } from "@inflight/web-backend";
import type { Video } from "@inflight/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { runPromise } from "@/lib/server";

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
		.select({
			video: videos,
			bucket: s3Buckets,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
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
			const [bucket] = yield* S3Buckets.getBucketAccess(
				Option.fromNullable(result.bucket?.id),
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

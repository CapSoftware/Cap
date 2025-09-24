"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets, videos } from "@cap/database/schema";
import { S3BucketAccess, S3Buckets } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
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
			const s3Buckets = yield* S3Buckets;
			const [S3ProviderLayer] = yield* s3Buckets.getProviderForBucket(
				Option.fromNullable(result.bucket?.id),
			);

			return yield* Effect.gen(function* () {
				const bucket = yield* S3BucketAccess;
				const transcriptKey = `${video.ownerId}/${videoId}/transcription.vtt`;
				return yield* bucket.getObject(transcriptKey);
			}).pipe(Effect.provide(S3ProviderLayer));
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

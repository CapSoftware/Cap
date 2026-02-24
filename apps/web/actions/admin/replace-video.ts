"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import { S3Bucket } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";

import { MESSENGER_ADMIN_EMAIL } from "@/lib/messenger/constants";
import { runPromise } from "@/lib/server";

export async function getVideoReplaceUploadUrl(videoId: string) {
	const user = await getCurrentUser();
	if (!user || user.email !== MESSENGER_ADMIN_EMAIL) {
		throw new Error("Unauthorized");
	}

	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			bucket: videos.bucket,
		})
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) {
		throw new Error("Video not found");
	}

	const fileKey = `${video.ownerId}/${video.id}/result.mp4`;

	const bucketIdOption = Option.fromNullable(video.bucket).pipe(
		Option.map((id) => S3Bucket.S3BucketId.make(id)),
	);

	const presignedUrl = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);
		return yield* bucket.getPresignedPutUrl(
			fileKey,
			{ ContentType: "video/mp4" },
			{ expiresIn: 1800 },
		);
	}).pipe(runPromise);

	return { presignedUrl };
}

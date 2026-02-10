import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import { S3Bucket, Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import { runPromise } from "@/lib/server";

import { withAuth } from "../../utils";

export const app = new Hono().use(withAuth);

app.post(
	"/",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { videoId } = c.req.valid("json");

		const id = Video.VideoId.make(videoId);

		const [video] = await db()
			.select({
				id: videos.id,
				ownerId: videos.ownerId,
				bucketId: videos.bucket,
			})
			.from(videos)
			.where(eq(videos.id, id));

		if (!video) return c.text("Video not found", 404);
		if (video.ownerId !== user.id) return c.text("Forbidden", 403);

		await db().delete(videoUploads).where(eq(videoUploads.videoId, id));

		const bucketIdOption = Option.fromNullable(video.bucketId).pipe(
			Option.map((bucketId) => S3Bucket.S3BucketId.make(bucketId)),
		);
		const fileKey = `${video.ownerId}/${video.id}/result.mp4`;

		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);
			yield* bucket.deleteObject(fileKey);
		}).pipe(runPromise);

		return c.json({ success: true });
	},
);

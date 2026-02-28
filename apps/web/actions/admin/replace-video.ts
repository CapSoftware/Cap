"use server";

import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { AwsCredentials, S3Buckets } from "@cap/web-backend";
import { S3Bucket } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";

import { MESSENGER_ADMIN_EMAIL } from "@/lib/messenger/constants";
import { runPromise } from "@/lib/server";

async function requireAdmin() {
	const user = await getCurrentUser();
	if (!user || user.email !== MESSENGER_ADMIN_EMAIL) {
		throw new Error("Unauthorized");
	}
	return user;
}

async function getVideoOrThrow(videoId: string) {
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
	return video;
}

export async function getVideoReplaceUploadUrl(videoId: string) {
	await requireAdmin();
	const video = await getVideoOrThrow(videoId);

	const fileKey = `${video.ownerId}/${video.id}/result.mp4`;

	const bucketIdOption = Option.fromNullable(video.bucket).pipe(
		Option.map((id) => S3Bucket.S3BucketId.make(id)),
	);

	const presignedPostData = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);
		return yield* bucket.getPresignedPostUrl(fileKey, {
			Fields: { "Content-Type": "video/mp4" },
			Expires: 1800,
		});
	}).pipe(runPromise);

	return { presignedPostData };
}

export async function invalidateVideoCache(videoId: string) {
	await requireAdmin();
	const video = await getVideoOrThrow(videoId);

	if (video.bucket) {
		return;
	}

	const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
	if (!distributionId) {
		return;
	}

	const fileKey = `${video.ownerId}/${video.id}/result.mp4`;

	const cloudfront = new CloudFrontClient({
		region: serverEnv().CAP_AWS_REGION || "us-east-1",
		credentials: await runPromise(
			Effect.map(AwsCredentials, (c) => c.credentials),
		),
	});

	await cloudfront.send(
		new CreateInvalidationCommand({
			DistributionId: distributionId,
			InvalidationBatch: {
				CallerReference: `${Date.now()}`,
				Paths: {
					Quantity: 1,
					Items: [`/${fileKey}`],
				},
			},
		}),
	);
}

"use server";

import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { AwsCredentials, Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { retireDesktopRecordingJobForOutputReplacement } from "@/lib/desktop-recording-jobs";
import { MESSENGER_ADMIN_EMAIL } from "@/lib/messenger/constants";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

async function requireAdmin() {
	const user = await getCurrentUser();
	if (!user || user.email !== MESSENGER_ADMIN_EMAIL) {
		throw new Error("Unauthorized");
	}
	return user;
}

async function getVideoOrThrow(videoId: string) {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));

	if (!video) {
		throw new Error("Video not found");
	}
	return video;
}

export async function getVideoReplaceUploadUrl(videoId: string) {
	await requireAdmin();
	const video = await getVideoOrThrow(videoId);

	const fileKey = `${video.ownerId}/${video.id}/result.mp4`;

	const [bucket] = await Storage.getAccessForVideo(decodeStorageVideo(video), {
		resolvePublishedOutput: false,
	}).pipe(runPromise);
	const presignedPostData = await bucket
		.getPresignedPostUrl(fileKey, {
			Fields: { "Content-Type": "video/mp4" },
			Expires: 1800,
		})
		.pipe(runPromise);

	return { presignedPostData };
}

export async function invalidateVideoCache(videoId: string) {
	await requireAdmin();
	const video = await getVideoOrThrow(videoId);
	const fileKey = `${video.ownerId}/${video.id}/result.mp4`;
	const [bucket] = await Storage.getAccessForVideo(decodeStorageVideo(video), {
		resolvePublishedOutput: false,
	}).pipe(runPromise);
	const head = await bucket.headObject(fileKey).pipe(runPromise);
	if (!head.ETag || !head.ContentLength || head.ContentLength <= 0) {
		throw new Error("Replacement recording has not finished uploading");
	}
	await db().transaction(async (tx) => {
		await retireDesktopRecordingJobForOutputReplacement(tx, {
			videoId: video.id,
			userId: video.ownerId,
		});
		const [lockedVideo] = await tx
			.select()
			.from(videos)
			.where(eq(videos.id, video.id))
			.for("update");
		if (
			!lockedVideo ||
			lockedVideo.ownerId !== video.ownerId ||
			lockedVideo.bucket !== video.bucket ||
			lockedVideo.storageIntegrationId !== video.storageIntegrationId
		) {
			throw new Error("Recording storage changed during replacement");
		}
		const metadata = { ...(lockedVideo.metadata ?? {}) };
		delete metadata.desktopRecordingUpload;
		await tx
			.update(videos)
			.set({
				metadata,
				source:
					lockedVideo.source.type === "webMP4"
						? lockedVideo.source
						: { type: "desktopMP4" },
			})
			.where(eq(videos.id, video.id));
		await tx.delete(videoUploads).where(eq(videoUploads.videoId, video.id));
	});

	if (video.bucket) {
		return;
	}

	const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
	if (!distributionId) {
		return;
	}

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

"use server";

import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { s3Buckets, videos, videoUploads } from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub, userIsPro } from "@cap/utils";
import { AwsCredentials, S3Buckets } from "@cap/web-backend";
import {
	type Folder,
	type Organisation,
	S3Bucket,
	Video,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";

const MAX_S3_DELETE_ATTEMPTS = 3;
const S3_DELETE_RETRY_BACKOFF_MS = 250;

async function getVideoUploadPresignedUrl({
	fileKey,
	duration,
	resolution,
	videoCodec,
	audioCodec,
	bucketId,
	userId,
}: {
	fileKey: string;
	duration?: string;
	resolution?: string;
	videoCodec?: string;
	audioCodec?: string;
	bucketId: string | undefined;
	userId: string;
}) {
	try {
		const bucketIdOption = Option.fromNullable(bucketId).pipe(
			Option.map((id) => S3Bucket.S3BucketId.make(id)),
		);

		if (Option.isNone(bucketIdOption)) {
			const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
			if (distributionId) {
				const cloudfront = new CloudFrontClient({
					region: serverEnv().CAP_AWS_REGION || "us-east-1",
					credentials: await runPromise(
						Effect.map(AwsCredentials, (c) => c.credentials),
					),
				});

				const pathToInvalidate = `/${fileKey}`;

				try {
					await cloudfront.send(
						new CreateInvalidationCommand({
							DistributionId: distributionId,
							InvalidationBatch: {
								CallerReference: `${Date.now()}`,
								Paths: {
									Quantity: 1,
									Items: [pathToInvalidate],
								},
							},
						}),
					);
				} catch (error) {
					console.error("Failed to create CloudFront invalidation:", error);
				}
			}
		}

		const contentType = fileKey.endsWith(".aac")
			? "audio/aac"
			: fileKey.endsWith(".webm")
				? "audio/webm"
				: fileKey.endsWith(".mp4")
					? "video/mp4"
					: fileKey.endsWith(".mp3")
						? "audio/mpeg"
						: fileKey.endsWith(".m3u8")
							? "application/x-mpegURL"
							: "video/mp2t";

		const Fields = {
			"Content-Type": contentType,
			"x-amz-meta-userid": userId,
			"x-amz-meta-duration": duration ?? "",
			"x-amz-meta-resolution": resolution ?? "",
			"x-amz-meta-videocodec": videoCodec ?? "",
			"x-amz-meta-audiocodec": audioCodec ?? "",
		};

		const presignedPostData = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);

			return yield* bucket.getPresignedPostUrl(fileKey, {
				Fields,
				Expires: 1800,
			});
		}).pipe(runPromise);

		return { presignedPostData };
	} catch (error) {
		console.error("Error getting presigned URL:", error);
		throw new Error(
			error instanceof Error ? error.message : "Failed to get presigned URL",
		);
	}
}

export async function createVideoAndGetUploadUrl({
	videoId,
	duration,
	resolution,
	videoCodec,
	audioCodec,
	isScreenshot = false,
	isUpload = false,
	folderId,
	orgId,
	supportsUploadProgress = false,
}: {
	videoId?: Video.VideoId;
	duration?: number;
	resolution?: string;
	videoCodec?: string;
	audioCodec?: string;
	isScreenshot?: boolean;
	isUpload?: boolean;
	folderId?: Folder.FolderId;
	orgId: Organisation.OrganisationId;
	// TODO: Remove this once we are happy with it's stability
	supportsUploadProgress?: boolean;
}) {
	const user = await getCurrentUser();

	if (!user) throw new Error("Unauthorized");

	try {
		if (!userIsPro(user) && duration && duration > 300)
			throw new Error("upgrade_required");

		const [customBucket] = await db()
			.select()
			.from(s3Buckets)
			.where(eq(s3Buckets.ownerId, user.id));

		const date = new Date();
		const formattedDate = `${date.getDate()} ${date.toLocaleString("default", {
			month: "long",
		})} ${date.getFullYear()}`;

		if (videoId) {
			const [existingVideo] = await db()
				.select()
				.from(videos)
				.where(eq(videos.id, videoId));

			if (existingVideo) {
				const fileKey = `${user.id}/${videoId}/${
					isScreenshot ? "screenshot/screen-capture.jpg" : "result.mp4"
				}`;
				const { presignedPostData } = await getVideoUploadPresignedUrl({
					fileKey,
					duration: duration?.toString(),
					resolution,
					videoCodec,
					audioCodec,
					bucketId: existingVideo.bucket ?? customBucket?.id,
					userId: user.id,
				});

				return {
					id: existingVideo.id,
					presignedPostData,
				};
			}
		}

		const idToUse = Video.VideoId.make(videoId || nanoId());

		const videoData = {
			id: idToUse,
			name: `Cap ${
				isScreenshot ? "Screenshot" : isUpload ? "Upload" : "Recording"
			} - ${formattedDate}`,
			ownerId: user.id,
			orgId,
			source: { type: "webMP4" as const },
			isScreenshot,
			bucket: customBucket?.id,
			public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
			...(folderId ? { folderId } : {}),
		};

		await db().insert(videos).values(videoData);

		if (supportsUploadProgress)
			await db().insert(videoUploads).values({
				videoId: idToUse,
			});

		const fileKey = `${user.id}/${idToUse}/${
			isScreenshot ? "screenshot/screen-capture.jpg" : "result.mp4"
		}`;
		const { presignedPostData } = await getVideoUploadPresignedUrl({
			fileKey,
			duration: duration?.toString(),
			resolution,
			videoCodec,
			audioCodec,
			bucketId: customBucket?.id,
			userId: user.id,
		});

		if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production") {
			await dub()
				.links.create({
					url: `${serverEnv().WEB_URL}/s/${idToUse}`,
					domain: "cap.link",
					key: idToUse,
				})
				.catch((err) => {
					console.error("Dub link create failed", err);
				});
		}

		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/folder");
		revalidatePath("/dashboard/spaces");

		return {
			id: idToUse,
			presignedPostData,
		};
	} catch (error) {
		console.error("Error creating video and getting upload URL:", error);
		throw new Error(
			error instanceof Error ? error.message : "Failed to create video",
		);
	}
}

export async function deleteVideoResultFile({
	videoId,
}: {
	videoId: Video.VideoId;
}) {
	const user = await getCurrentUser();

	if (!user) throw new Error("Unauthorized");

	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			bucketId: videos.bucket,
		})
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) throw new Error("Forbidden");

	const bucketIdOption = Option.fromNullable(video.bucketId).pipe(
		Option.map((id) => S3Bucket.S3BucketId.make(id)),
	);
	const fileKey = `${video.ownerId}/${video.id}/result.mp4`;
	const logContext = {
		videoId: video.id,
		ownerId: video.ownerId,
		bucketId: video.bucketId ?? null,
		fileKey,
	};

	try {
		await db().transaction(async (tx) => {
			await tx.delete(videoUploads).where(eq(videoUploads.videoId, videoId));
		});
	} catch (error) {
		console.error("video.result.delete.transaction_failure", {
			...logContext,
			error: serializeError(error),
		});
		throw error;
	}

	try {
		await deleteResultObjectWithRetry({
			bucketIdOption,
			fileKey,
			logContext,
		});
	} catch (error) {
		console.error("video.result.delete.s3_failure", {
			...logContext,
			error: serializeError(error),
		});
		throw error;
	}

	revalidatePath(`/s/${videoId}`);
	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/folder");
	revalidatePath("/dashboard/spaces");

	return { success: true };
}

async function deleteResultObjectWithRetry({
	bucketIdOption,
	fileKey,
	logContext,
}: {
	bucketIdOption: Option.Option<S3Bucket.S3BucketId>;
	fileKey: string;
	logContext: {
		videoId: Video.VideoId;
		ownerId: string;
		bucketId: string | null;
		fileKey: string;
	};
}) {
	let attempt = 0;
	let lastError: unknown;
	while (attempt < MAX_S3_DELETE_ATTEMPTS) {
		attempt += 1;
		try {
			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(bucketIdOption);
				yield* bucket.deleteObject(fileKey);
			}).pipe(runPromise);
			return;
		} catch (error) {
			lastError = error;
			console.error("video.result.delete.s3_failure", {
				...logContext,
				attempt,
				maxAttempts: MAX_S3_DELETE_ATTEMPTS,
				error: serializeError(error),
			});

			if (attempt < MAX_S3_DELETE_ATTEMPTS) {
				await sleep(S3_DELETE_RETRY_BACKOFF_MS * attempt);
			}
		}
	}

	throw lastError instanceof Error
		? lastError
		: new Error("Failed to delete video result from S3");
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}

	return { name: "UnknownError", message: String(error) };
}

function sleep(durationMs: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, durationMs);
	});
}

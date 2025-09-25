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
import { userIsPro } from "@cap/utils";
import { S3Buckets } from "@cap/web-backend";
import { type Folder, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";
import { dub } from "@/utils/dub";

async function getVideoUploadPresignedUrl({
	fileKey,
	duration,
	resolution,
	videoCodec,
	audioCodec,
}: {
	fileKey: string;
	duration?: string;
	resolution?: string;
	videoCodec?: string;
	audioCodec?: string;
}) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	try {
		const [customBucket] = await db()
			.select()
			.from(s3Buckets)
			.where(eq(s3Buckets.ownerId, user.id));

		const s3Config = customBucket
			? {
					endpoint: customBucket.endpoint || undefined,
					region: customBucket.region,
					accessKeyId: customBucket.accessKeyId,
					secretAccessKey: customBucket.secretAccessKey,
				}
			: null;

		if (
			!customBucket ||
			!s3Config ||
			customBucket.bucketName !== serverEnv().CAP_AWS_BUCKET
		) {
			const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
			if (distributionId) {
				const cloudfront = new CloudFrontClient({
					region: serverEnv().CAP_AWS_REGION || "us-east-1",
					credentials: {
						accessKeyId: serverEnv().CAP_AWS_ACCESS_KEY || "",
						secretAccessKey: serverEnv().CAP_AWS_SECRET_KEY || "",
					},
				});

				const pathToInvalidate = "/" + fileKey;

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
			"x-amz-meta-userid": user.id,
			"x-amz-meta-duration": duration ?? "",
			"x-amz-meta-resolution": resolution ?? "",
			"x-amz-meta-videocodec": videoCodec ?? "",
			"x-amz-meta-audiocodec": audioCodec ?? "",
		};

		const presignedPostData = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(
				Option.fromNullable(customBucket?.id),
			);

			const presignedPostData = yield* bucket.getPresignedPostUrl(fileKey, {
				Fields,
				Expires: 1800,
			});

			const customEndpoint = serverEnv().CAP_AWS_ENDPOINT;
			if (customEndpoint && !customEndpoint.includes("amazonaws.com")) {
				if (serverEnv().S3_PATH_STYLE) {
					presignedPostData.url = `${customEndpoint}/${bucket.bucketName}`;
				} else {
					presignedPostData.url = customEndpoint;
				}
			}

			return presignedPostData;
		}).pipe(runPromise);

		const videoId = fileKey.split("/")[1];
		if (videoId) {
			try {
				await fetch(`${serverEnv().WEB_URL}/api/revalidate`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ videoId }),
				});
			} catch (revalidateError) {
				console.error("Failed to revalidate page:", revalidateError);
			}
		}

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
			source: { type: "desktopMP4" as const },
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

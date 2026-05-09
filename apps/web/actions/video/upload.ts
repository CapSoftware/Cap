"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { videos, videoUploads } from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub, userIsPro } from "@cap/utils";
import { Storage as StorageService } from "@cap/web-backend";
import {
	type Folder,
	type Organisation,
	type User,
	Video,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { requireOrganizationAccess } from "@/actions/organization/authorization";
import { runPromise } from "@/lib/server";

const MAX_S3_DELETE_ATTEMPTS = 3;
const S3_DELETE_RETRY_BACKOFF_MS = 250;

async function getVideoUploadPresignedUrl({
	fileKey,
	duration,
	resolution,
	videoCodec,
	audioCodec,
	video,
	userId,
	organizationId,
}: {
	fileKey: string;
	duration?: string;
	resolution?: string;
	videoCodec?: string;
	audioCodec?: string;
	video?: Video.Video;
	userId: User.UserId;
	organizationId?: Organisation.OrganisationId;
}) {
	try {
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
			"x-amz-meta-userid": userId,
			"x-amz-meta-duration": duration ?? "",
			"x-amz-meta-resolution": resolution ?? "",
			"x-amz-meta-videocodec": videoCodec ?? "",
			"x-amz-meta-audiocodec": audioCodec ?? "",
		};

		const result = await Effect.gen(function* () {
			if (video) {
				const upload = yield* StorageService.createUploadTargetForVideo(
					video,
					fileKey,
					{
						contentType,
						fields: Fields,
					},
				);
				return {
					upload,
					bucketId: video.bucketId,
					storageIntegrationId: video.storageIntegrationId,
				};
			}

			return yield* StorageService.createUploadTargetForUser(
				userId,
				fileKey,
				{
					contentType,
					fields: Fields,
				},
				organizationId,
			);
		}).pipe(runPromise);

		return {
			...result,
			presignedPostData:
				result.upload.type === "s3Post"
					? { url: result.upload.url, fields: result.upload.fields }
					: null,
		};
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

		await requireOrganizationAccess(user.id, orgId);

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
				if (existingVideo.ownerId !== user.id) throw new Error("Forbidden");

				const existingVideoDomain = Video.Video.decodeSync({
					...existingVideo,
					bucketId: existingVideo.bucket,
					storageIntegrationId: existingVideo.storageIntegrationId,
					createdAt: existingVideo.createdAt.toISOString(),
					updatedAt: existingVideo.updatedAt.toISOString(),
					metadata: existingVideo.metadata,
				});
				const fileKey = `${user.id}/${videoId}/${
					isScreenshot ? "screenshot/screen-capture.jpg" : "result.mp4"
				}`;
				const { presignedPostData, upload } = await getVideoUploadPresignedUrl({
					fileKey,
					duration: duration?.toString(),
					resolution,
					videoCodec,
					audioCodec,
					video: existingVideoDomain,
					userId: user.id,
				});

				return {
					id: existingVideo.id,
					presignedPostData,
					uploadTarget: upload,
				};
			}
		}

		const idToUse = Video.VideoId.make(videoId || nanoId());

		const fileKey = `${user.id}/${idToUse}/${
			isScreenshot ? "screenshot/screen-capture.jpg" : "result.mp4"
		}`;
		const { presignedPostData, upload, bucketId, storageIntegrationId } =
			await getVideoUploadPresignedUrl({
				fileKey,
				duration: duration?.toString(),
				resolution,
				videoCodec,
				audioCodec,
				userId: user.id,
				organizationId: orgId,
			});

		const videoData = {
			id: idToUse,
			name: `Cap ${
				isScreenshot ? "Screenshot" : isUpload ? "Upload" : "Recording"
			} - ${formattedDate}`,
			ownerId: user.id,
			orgId,
			source: { type: "webMP4" as const },
			isScreenshot,
			bucket: Option.getOrNull(bucketId),
			storageIntegrationId: Option.getOrNull(storageIntegrationId),
			public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
			...(folderId ? { folderId } : {}),
		};

		await db().insert(videos).values(videoData);

		if (supportsUploadProgress)
			await db().insert(videoUploads).values({
				videoId: idToUse,
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
			uploadTarget: upload,
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
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) throw new Error("Forbidden");

	const videoDomain = Video.Video.decodeSync({
		...video,
		bucketId: video.bucket,
		storageIntegrationId: video.storageIntegrationId,
		createdAt: video.createdAt.toISOString(),
		updatedAt: video.updatedAt.toISOString(),
		metadata: video.metadata,
	});
	const fileKey = `${video.ownerId}/${video.id}/result.mp4`;
	const logContext = {
		videoId: video.id,
		ownerId: video.ownerId,
		bucketId: video.bucket ?? null,
		storageIntegrationId: video.storageIntegrationId ?? null,
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
			video: videoDomain,
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
	video,
	fileKey,
	logContext,
}: {
	video: Video.Video;
	fileKey: string;
	logContext: {
		videoId: Video.VideoId;
		ownerId: string;
		bucketId: string | null;
		storageIntegrationId: string | null;
		fileKey: string;
	};
}) {
	let attempt = 0;
	let lastError: unknown;
	while (attempt < MAX_S3_DELETE_ATTEMPTS) {
		attempt += 1;
		try {
			await Effect.gen(function* () {
				const [bucket] = yield* StorageService.getAccessForVideo(video);
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

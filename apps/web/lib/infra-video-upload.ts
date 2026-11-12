import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerApps,
	developerCreditAccounts,
	developerVideos,
} from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { provideOptionalAuth, S3Buckets } from "@cap/web-backend";
import type { User } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Option } from "effect";
import { billableVideo } from "@/lib/developer-pricing";
import { canUseInfra } from "@/lib/infra-access";
import {
	getInfraUploadAdmission,
	uploadAdmissionError,
} from "@/lib/infra-standing";
import { runPromise } from "@/lib/server";

export const MAX_UPLOAD_DURATION_SECS = 4 * 60 * 60;
export const MAX_PRESIGN_BATCH = 50;
const STORED_BYTES_PER_SECOND = 2_500_000;
const MIN_PLAUSIBLE_BYTES_PER_SECOND = 1_000;

const ALLOWED_CONTENT_TYPES = [
	"video/mp4",
	"video/webm",
	"video/quicktime",
	"video/x-matroska",
	"video/avi",
	"application/octet-stream",
];

export type UploadStatus = 200 | 400 | 402 | 404 | 409 | 500;

export type UploadResult<T> =
	| { status: 200; body: T }
	| {
			status: Exclude<UploadStatus, 200>;
			body: { error: string } & Record<string, unknown>;
	  };

export type UploadPart = { partNumber: number; etag: string; size: number };

type StoredPart = { PartNumber?: number; ETag?: string; Size?: number };

const ok = <T>(body: T): UploadResult<T> => ({ status: 200, body });

const fail = (
	status: Exclude<UploadStatus, 200>,
	error: string,
	extra: Record<string, unknown> = {},
) => ({ status, body: { error, ...extra } });

const withoutQuotes = (etag: string | undefined) => etag?.replaceAll('"', "");

function storedBytesForParts(
	requestedParts: readonly { partNumber: number; etag: string }[],
	storedParts: readonly StoredPart[],
) {
	const storedByNumber = new Map(
		storedParts.map((part) => [part.PartNumber, part]),
	);
	const seen = new Set<number>();
	let totalBytes = 0;
	for (const requested of requestedParts) {
		if (seen.has(requested.partNumber)) return null;
		seen.add(requested.partNumber);
		const stored = storedByNumber.get(requested.partNumber);
		if (
			stored?.Size === undefined ||
			withoutQuotes(stored.ETag) !== withoutQuotes(requested.etag)
		) {
			return null;
		}
		totalBytes += stored.Size;
	}
	return totalBytes;
}

async function findAppVideo(appId: string, videoId: string) {
	const [video] = await db()
		.select({
			appId: developerVideos.appId,
			s3Key: developerVideos.s3Key,
			duration: developerVideos.duration,
			deletedAt: developerVideos.deletedAt,
		})
		.from(developerVideos)
		.where(eq(developerVideos.id, videoId))
		.limit(1);

	return video && video.appId === appId ? video : null;
}

async function openUpload(appId: string, videoId: string) {
	const video = await findAppVideo(appId, videoId);
	if (!video || video.deletedAt) return fail(404, "Video not found");
	if (video.duration !== null) return fail(409, "Upload already completed");
	if (!video.s3Key) return fail(400, "Video has no S3 key");
	return { status: 200 as const, s3Key: video.s3Key };
}

export async function ownsInfraApp(
	user: { id: User.UserId; email: string },
	appId: string,
) {
	if (!canUseInfra(user.email)) return false;
	const [app] = await db()
		.select({ id: developerApps.id })
		.from(developerApps)
		.where(
			and(
				eq(developerApps.id, appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);
	return !!app;
}

export async function createInfraVideo({
	appId,
	name,
	userId,
	metadata,
}: {
	appId: string;
	name?: string;
	userId?: string;
	metadata?: Record<string, unknown>;
}): Promise<
	UploadResult<{
		videoId: string;
		s3Key: string;
		shareUrl: string;
		embedUrl: string;
	}>
> {
	const admission = await getInfraUploadAdmission(appId);
	if (!admission.allowed) {
		return { status: 402, body: uploadAdmissionError(admission) };
	}

	const videoId = nanoId();
	const s3Key = `developer/${appId}/${videoId}/video`;

	await db()
		.insert(developerVideos)
		.values({
			id: videoId,
			appId,
			externalUserId: userId,
			name: name ?? "Untitled",
			s3Key,
			metadata,
		});

	const webUrl = buildEnv.NEXT_PUBLIC_WEB_URL;

	return ok({
		videoId,
		s3Key,
		shareUrl: `${webUrl}/dev/${videoId}`,
		embedUrl: `${webUrl}/embed/${videoId}?sdk=1`,
	});
}

export async function initiateInfraUpload({
	appId,
	videoId,
	contentType,
}: {
	appId: string;
	videoId: string;
	contentType?: string;
}): Promise<UploadResult<{ uploadId: string }>> {
	const upload = await openUpload(appId, videoId);
	if (upload.status !== 200) return upload;
	const { s3Key } = upload;

	const resolvedContentType =
		contentType && ALLOWED_CONTENT_TYPES.includes(contentType)
			? contentType
			: "video/mp4";

	try {
		const uploadId = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
			const { UploadId } = yield* bucket.multipart.create(s3Key, {
				ContentType: resolvedContentType,
				CacheControl: "max-age=31536000",
			});
			if (!UploadId) throw new Error("No UploadId returned");
			return UploadId;
		}).pipe(provideOptionalAuth, runPromise);

		return ok({ uploadId });
	} catch (error) {
		console.error("Error initiating multipart upload:", error);
		return fail(500, "Failed to initiate upload");
	}
}

export async function presignInfraUploadParts({
	appId,
	videoId,
	uploadId,
	partNumbers,
}: {
	appId: string;
	videoId: string;
	uploadId: string;
	partNumbers: readonly number[];
}): Promise<
	UploadResult<{ parts: { partNumber: number; presignedUrl: string }[] }>
> {
	if (partNumbers.length === 0 || partNumbers.length > MAX_PRESIGN_BATCH) {
		return fail(400, `Ask for 1 to ${MAX_PRESIGN_BATCH} parts at a time`);
	}
	const upload = await openUpload(appId, videoId);
	if (upload.status !== 200) return upload;
	const { s3Key } = upload;

	try {
		const parts = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
			return yield* Effect.forEach(
				partNumbers,
				(partNumber) =>
					bucket.multipart
						.getPresignedUploadPartUrl(s3Key, uploadId, partNumber)
						.pipe(Effect.map((presignedUrl) => ({ partNumber, presignedUrl }))),
				{ concurrency: 10 },
			);
		}).pipe(provideOptionalAuth, runPromise);

		return ok({ parts });
	} catch (error) {
		console.error("Error creating presigned URL:", error);
		return fail(500, "Failed to create presigned URL");
	}
}

export async function completeInfraUpload({
	appId,
	videoId,
	uploadId,
	parts,
	durationInSecs,
	width,
	height,
	fps,
}: {
	appId: string;
	videoId: string;
	uploadId: string;
	parts: readonly UploadPart[];
	durationInSecs: number;
	width?: number;
	height?: number;
	fps?: number;
}): Promise<UploadResult<{ success: true }>> {
	const clampedDuration = Math.min(durationInSecs, MAX_UPLOAD_DURATION_SECS);

	const video = await findAppVideo(appId, videoId);
	if (!video || video.deletedAt) return fail(404, "Video not found");
	if (video.duration !== null) return ok({ success: true });
	if (!video.s3Key) return fail(400, "Video has no S3 key");
	const s3Key = video.s3Key;

	try {
		const measured = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
			return yield* bucket.multipart.listParts(s3Key, uploadId).pipe(
				Effect.map((storedParts) => ({
					assembled: false as const,
					totalBytes: storedBytesForParts(parts, storedParts),
				})),
				Effect.catchAll((listError) =>
					bucket.headObject(s3Key).pipe(
						Effect.map((object) => ({
							assembled: true as const,
							totalBytes: object.ContentLength ?? null,
						})),
						Effect.catchAll(() => Effect.fail(listError)),
					),
				),
			);
		}).pipe(provideOptionalAuth, runPromise);

		const { totalBytes } = measured;
		if (totalBytes === null) {
			return fail(400, "Uploaded parts do not match the request");
		}
		const plausibleDuration = Math.min(
			clampedDuration,
			totalBytes / MIN_PLAUSIBLE_BYTES_PER_SECOND,
		);
		const sizeBasedMinDuration = totalBytes / STORED_BYTES_PER_SECOND;
		const storedDuration = Math.min(
			Math.max(plausibleDuration, sizeBasedMinDuration),
			MAX_UPLOAD_DURATION_SECS,
		);
		const newVideo = billableVideo({
			duration: storedDuration,
			width,
			height,
		});

		if (!measured.assembled) {
			if (await videoIsRecorded(db(), videoId)) return ok({ success: true });
			const admission = await getInfraUploadAdmission(appId, newVideo);
			if (!admission.allowed) {
				return { status: 402, body: uploadAdmissionError(admission) };
			}

			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());

				const sortedParts = [...parts].sort(
					(a, b) => a.partNumber - b.partNumber,
				);
				const formattedParts = sortedParts.map((part) => ({
					PartNumber: part.partNumber,
					ETag: part.etag,
				}));

				yield* bucket.multipart.complete(s3Key, uploadId, {
					MultipartUpload: { Parts: formattedParts },
				});
			}).pipe(provideOptionalAuth, runPromise);
		}

		const updates: Partial<typeof developerVideos.$inferInsert> = {
			duration: storedDuration,
		};
		if (width !== undefined) updates.width = width;
		if (height !== undefined) updates.height = height;
		if (fps !== undefined) updates.fps = fps;

		const admission = await db().transaction(async (tx) => {
			await tx
				.select({ id: developerCreditAccounts.id })
				.from(developerCreditAccounts)
				.where(eq(developerCreditAccounts.appId, appId))
				.limit(1)
				.for("update");

			if (await videoIsRecorded(tx, videoId)) return ALREADY_RECORDED;

			const admission = await getInfraUploadAdmission(appId, newVideo, tx);
			if (!admission.allowed) return admission;

			await tx
				.update(developerVideos)
				.set(updates)
				.where(
					and(
						eq(developerVideos.id, videoId),
						isNull(developerVideos.duration),
					),
				);
			return admission;
		});

		if (!admission.allowed) {
			return { status: 402, body: uploadAdmissionError(admission) };
		}

		return ok({ success: true });
	} catch (error) {
		console.error("Error completing multipart upload:", error);
		return fail(500, "Failed to complete upload");
	}
}

const ALREADY_RECORDED = { allowed: true } as const;

async function videoIsRecorded(
	executor: Pick<ReturnType<typeof db>, "select">,
	videoId: string,
) {
	const [row] = await executor
		.select({ duration: developerVideos.duration })
		.from(developerVideos)
		.where(eq(developerVideos.id, videoId))
		.limit(1);
	return !!row && row.duration !== null;
}

export async function abortInfraUpload({
	appId,
	videoId,
	uploadId,
}: {
	appId: string;
	videoId: string;
	uploadId: string;
}): Promise<UploadResult<{ success: true }>> {
	const video = await findAppVideo(appId, videoId);
	if (!video) return fail(404, "Video not found");
	if (!video.s3Key) return fail(400, "Video has no S3 key");
	const s3Key = video.s3Key;

	try {
		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
			yield* bucket.multipart.abort(s3Key, uploadId);
		}).pipe(provideOptionalAuth, runPromise);

		return ok({ success: true });
	} catch (error) {
		console.error("Error aborting multipart upload:", error);
		return fail(500, "Failed to abort upload");
	}
}

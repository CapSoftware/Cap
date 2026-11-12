import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { developerApps, developerVideos } from "@cap/database/schema";
import type { DeveloperVideoResolutionTier } from "@cap/database/types";
import { buildEnv } from "@cap/env";
import { provideOptionalAuth, S3Buckets } from "@cap/web-backend";
import type { User } from "@cap/web-domain";
import { and, asc, eq, gt, isNotNull, isNull, lt, lte } from "drizzle-orm";
import { Effect, Option } from "effect";
import { developerVideoPageUrls } from "@/lib/developer-video-api";
import {
	admitDeveloperVideoUpload,
	type DeveloperVideoUpload,
} from "@/lib/developer-video-charge";
import {
	createDeveloperPlaybackId,
	DEVELOPER_VIDEO_DEFAULT_TIER,
} from "@/lib/developer-video-plan";
import type { DeveloperVideoClaim } from "@/lib/developer-video-processing";
import {
	claimDeveloperVideoUpload,
	releaseDeveloperVideoUpload,
	startDeveloperVideoProcessing,
} from "@/lib/developer-video-start";
import { canUseInfra } from "@/lib/infra-access";
import { lockInfraAccount } from "@/lib/infra-balance";
import {
	getInfraUploadAdmission,
	uploadAdmissionError,
} from "@/lib/infra-standing";
import { COMPLETION_IN_PROGRESS } from "@/lib/infra-upload";
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
			maxResolutionTier: developerVideos.maxResolutionTier,
			status: developerVideos.status,
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
	maxResolutionTier,
}: {
	appId: string;
	name?: string;
	userId?: string;
	metadata?: Record<string, unknown>;
	maxResolutionTier?: DeveloperVideoResolutionTier;
}): Promise<
	UploadResult<{
		videoId: string;
		playbackId: string;
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
	const playbackId = createDeveloperPlaybackId();
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
			playbackId,
			maxResolutionTier: maxResolutionTier ?? DEVELOPER_VIDEO_DEFAULT_TIER,
		});

	return ok({
		videoId,
		playbackId,
		s3Key,
		...developerVideoPageUrls(playbackId, buildEnv.NEXT_PUBLIC_WEB_URL),
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

export function recordedUploadDuration(
	reportedSeconds: number,
	totalBytes: number,
) {
	const plausibleDuration = Math.min(
		Math.min(reportedSeconds, MAX_UPLOAD_DURATION_SECS),
		totalBytes / MIN_PLAUSIBLE_BYTES_PER_SECOND,
	);
	const sizeBasedMinDuration = totalBytes / STORED_BYTES_PER_SECOND;
	return Math.min(
		Math.max(plausibleDuration, sizeBasedMinDuration),
		MAX_UPLOAD_DURATION_SECS,
	);
}

export async function claimInfraUploadCompletion(videoId: string) {
	const claim = await claimDeveloperVideoUpload(videoId);
	if (claim || !(await releaseStaleUploadClaim(videoId, Date.now()))) {
		return claim;
	}
	return claimDeveloperVideoUpload(videoId);
}

export function recordAdmittedInfraUpload(
	upload: DeveloperVideoUpload,
	updates: Partial<typeof developerVideos.$inferInsert>,
) {
	return db().transaction(async (tx) => {
		await lockInfraAccount(tx, upload.appId);

		const [current] = await tx
			.select({
				duration: developerVideos.duration,
				deletedAt: developerVideos.deletedAt,
			})
			.from(developerVideos)
			.where(eq(developerVideos.id, upload.videoId))
			.limit(1);
		if (!current || current.deletedAt) return REMOVED;
		if (current.duration !== null) return ALREADY_RECORDED;

		const admission = await admitDeveloperVideoUpload({
			...upload,
			executor: tx,
		});
		if (!admission.allowed) return admission;

		await tx
			.update(developerVideos)
			.set(updates)
			.where(
				and(
					eq(developerVideos.id, upload.videoId),
					isNull(developerVideos.duration),
				),
			);
		return admission;
	});
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
	const video = await findAppVideo(appId, videoId);
	if (!video || video.deletedAt) return fail(404, "Video not found");
	if (video.duration !== null) return ok({ success: true });
	if (!video.s3Key) return fail(400, "Video has no S3 key");
	const s3Key = video.s3Key;

	let claim: DeveloperVideoClaim | null = null;

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
		const storedDuration = recordedUploadDuration(durationInSecs, totalBytes);
		const upload = {
			appId,
			videoId,
			durationSeconds: storedDuration,
			width,
			height,
			maxResolutionTier: video.maxResolutionTier,
		};

		if (!measured.assembled) {
			if (await videoIsRecorded(db(), videoId)) return ok({ success: true });
			const admission = await admitDeveloperVideoUpload(upload);
			if (!admission.allowed) {
				return { status: 402, body: uploadAdmissionError(admission) };
			}
		}

		claim = await claimInfraUploadCompletion(videoId);
		if (!claim) {
			if (await videoIsRecorded(db(), videoId)) return ok({ success: true });
			return fail(
				409,
				"Another request is completing this upload. Try again shortly.",
				{ code: COMPLETION_IN_PROGRESS },
			);
		}

		if (!measured.assembled) {
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

		const admission = await recordAdmittedInfraUpload(upload, updates);

		if ("removed" in admission) {
			await releaseDeveloperVideoUpload(videoId, claim);
			claim = null;
			return fail(
				409,
				"This upload was removed before it was recorded. Create a new video and upload the file again.",
				{ code: "upload_removed" },
			);
		}

		if (!admission.allowed) {
			await removeStoredFile(s3Key);
			await releaseDeveloperVideoUpload(videoId, claim);
			claim = null;
			const refusal = uploadAdmissionError(admission);
			return {
				status: 402,
				body: {
					...refusal,
					message: `${refusal.message} The uploaded file was removed, so upload it again once credit is added.`,
					fileRemoved: true,
				},
			};
		}

		await startDeveloperVideoProcessing(videoId, claim);

		return ok({ success: true });
	} catch (error) {
		console.error("Error completing multipart upload:", error);
		if (claim) {
			await releaseDeveloperVideoUpload(videoId, claim).catch(() => {});
		}
		return fail(500, "Failed to complete upload");
	}
}

async function removeStoredFile(s3Key: string) {
	try {
		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
			yield* bucket.deleteObject(s3Key);
		}).pipe(provideOptionalAuth, runPromise);
		return true;
	} catch (error) {
		console.error("Error removing an unrecorded upload:", s3Key, error);
		return false;
	}
}

const UNRECORDED_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UNRECORDED_PAGE = 200;
const UNRECORDED_ROWS_PER_RUN = 1_000;

async function retireUnrecordedVideo(
	appId: string,
	videoId: string,
	now: Date,
) {
	return db().transaction(async (tx) => {
		await lockInfraAccount(tx, appId);

		const [current] = await tx
			.select({
				duration: developerVideos.duration,
				deletedAt: developerVideos.deletedAt,
			})
			.from(developerVideos)
			.where(eq(developerVideos.id, videoId))
			.limit(1);
		if (!current || current.duration !== null) return false;
		if (current.deletedAt) return true;

		await tx
			.update(developerVideos)
			.set({ deletedAt: now })
			.where(
				and(eq(developerVideos.id, videoId), isNull(developerVideos.duration)),
			);
		return true;
	});
}

async function unrecordedVideosPage(
	now: Date,
	after: string,
	upTo: string | null,
) {
	return db()
		.select({
			id: developerVideos.id,
			appId: developerVideos.appId,
			s3Key: developerVideos.s3Key,
		})
		.from(developerVideos)
		.where(
			and(
				isNull(developerVideos.duration),
				isNull(developerVideos.deletedAt),
				isNotNull(developerVideos.s3Key),
				lt(
					developerVideos.createdAt,
					new Date(now.getTime() - UNRECORDED_FILE_MAX_AGE_MS),
				),
				gt(developerVideos.id, after),
				upTo === null ? undefined : lte(developerVideos.id, upTo),
			),
		)
		.orderBy(asc(developerVideos.id))
		.limit(UNRECORDED_PAGE);
}

async function removeUnrecordedFile(
	row: { id: string; appId: string; s3Key: string | null },
	now: Date,
) {
	const s3Key = row.s3Key;
	if (!s3Key) return false;
	const stale = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
		const object = yield* bucket.headObject(s3Key);
		const modified = object.LastModified?.getTime() ?? 0;
		return modified <= now.getTime() - UNRECORDED_FILE_MAX_AGE_MS;
	})
		.pipe(provideOptionalAuth, runPromise)
		.catch(() => false);
	if (!stale) return false;
	const retired = await retireUnrecordedVideo(row.appId, row.id, now).catch(
		(error) => {
			console.error("Error retiring an unrecorded upload:", row.id, error);
			return false;
		},
	);
	return retired && (await removeStoredFile(s3Key));
}

export async function removeUnrecordedInfraFiles(
	now: Date = new Date(),
	start: string = nanoId(),
) {
	let removed = 0;
	let examined = 0;
	let after = start;
	let wrapped = false;
	while (examined < UNRECORDED_ROWS_PER_RUN) {
		const rows = await unrecordedVideosPage(now, after, wrapped ? start : null);
		for (const row of rows) {
			examined++;
			if (await removeUnrecordedFile(row, now)) removed++;
		}
		const last = rows.at(-1);
		if (rows.length === UNRECORDED_PAGE && last) {
			after = last.id;
		} else if (wrapped) {
			break;
		} else {
			wrapped = true;
			after = "";
		}
	}
	return removed;
}

const STALE_UPLOAD_CLAIM_MS = 15 * 60 * 1000;

async function releaseStaleUploadClaim(videoId: string, now: number) {
	return db().transaction(async (tx) => {
		const [video] = await tx
			.select({
				status: developerVideos.status,
				duration: developerVideos.duration,
				updatedAt: developerVideos.updatedAt,
				deletedAt: developerVideos.deletedAt,
			})
			.from(developerVideos)
			.where(eq(developerVideos.id, videoId))
			.for("update");
		if (
			!video ||
			video.deletedAt ||
			video.status !== "processing" ||
			video.duration !== null ||
			now - video.updatedAt.getTime() < STALE_UPLOAD_CLAIM_MS
		) {
			return false;
		}
		await tx
			.update(developerVideos)
			.set({ status: "uploading", processing: null })
			.where(eq(developerVideos.id, videoId));
		return true;
	});
}

export const ALREADY_RECORDED = { allowed: true } as const;
const REMOVED = { allowed: false, removed: true } as const;

export async function videoIsRecorded(
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
	if (video.status === "processing" && video.duration === null) {
		return fail(
			409,
			"Another request is completing this upload, so it cannot be aborted.",
			{ code: COMPLETION_IN_PROGRESS },
		);
	}
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

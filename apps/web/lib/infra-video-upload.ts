import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { developerApps, developerVideos } from "@cap/database/schema";
import type { DeveloperVideoResolutionTier } from "@cap/database/types";
import { buildEnv } from "@cap/env";
import { provideOptionalAuth, S3Buckets } from "@cap/web-backend";
import type { User } from "@cap/web-domain";
import { and, asc, eq, gt, isNotNull, isNull, lt, lte } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";
import { API_RETRY_HINT, apiErrorBody } from "@/lib/api-errors";
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
// A file is billed for at least its size at STORED_BYTES_PER_SECOND, and for
// at most MAX_UPLOAD_DURATION_SECS. Past this size the two meet, so every
// further byte would be stored without being billed.
export const MAX_UPLOAD_BYTES =
	MAX_UPLOAD_DURATION_SECS * STORED_BYTES_PER_SECOND;

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
			body: { error: string; code: string; hint?: string } & Record<
				string,
				unknown
			>;
			headers?: Record<string, string>;
	  };

export type UploadPart = { partNumber: number; etag: string; size: number };

type StoredPart = { PartNumber?: number; ETag?: string; Size?: number };

const ok = <T>(body: T): UploadResult<T> => ({ status: 200, body });

const fail = (
	status: Exclude<UploadStatus, 200>,
	code: string,
	error: string,
	hint: string,
) => ({ status, body: apiErrorBody(code, error, hint) });

const videoNotFound = () =>
	fail(
		404,
		"video_not_found",
		"Video not found",
		"Check the video ID and that it belongs to this app. Deleted videos are not returned.",
	);

const videoNotUploadable = () =>
	fail(
		400,
		"video_not_uploadable",
		"Video cannot accept an upload",
		"Create a new video and upload the file to that one.",
	);

const storageFailure = (error: string) =>
	fail(500, "internal_error", error, API_RETRY_HINT);

const completionInProgress = (error: string, hint: string) =>
	fail(409, COMPLETION_IN_PROGRESS, error, hint);

const uploadNotFound = (hint: string) =>
	fail(404, "upload_not_found", "No open upload matches this uploadId", hint);

const partsMismatch = () =>
	fail(
		400,
		"parts_mismatch",
		"Uploaded parts do not match the request",
		"Send each uploaded part once, with its partNumber and the ETag header its PUT returned. Upload any missing part again first.",
	);

const uploadByteLimit = (maxBytes: number | null | undefined) =>
	Math.min(maxBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);

const fileTooLarge = (limit: number = MAX_UPLOAD_BYTES, discarded = true) =>
	fail(
		400,
		"file_too_large",
		limit < MAX_UPLOAD_BYTES
			? `The file is larger than the ${limit} byte limit set for this upload`
			: `The file is larger than the ${MAX_UPLOAD_BYTES / 1e9} GB upload limit`,
		[
			discarded
				? "The upload was discarded and the video can take a new one."
				: "No upload was opened.",
			limit < MAX_UPLOAD_BYTES
				? "Upload a smaller file, or get a token with a larger maxBytes from your server, then call initiate again."
				: "Export the video at a lower bitrate or split it, then call initiate again and upload the smaller file.",
		].join(" "),
	);

const MIN_PART_BYTES = 5 * 1024 * 1024;
// The cleanup aborts an upload a day after it was opened, so only a recent one
// is handed back. An older one is left for the cleanup and a new one is opened.
const OPEN_UPLOAD_REUSE_MS = 6 * 60 * 60 * 1000;
const OPEN_UPLOAD_LIST_PAGES = 10;

type UploadListing = {
	Uploads?: { Key?: string; UploadId?: string; Initiated?: Date }[];
	IsTruncated?: boolean;
	NextKeyMarker?: string;
	NextUploadIdMarker?: string;
};

// A video keeps one open upload: asking again returns the newest recent one,
// so repeated calls cannot pile up uploads whose parts sit in storage unpaid
// until the cleanup removes them. Nothing is aborted here, because another
// client may still be sending parts to an upload or completing it. If the
// listing fails, the caller opens an upload as before.
function newestOpenUpload<E, R>(
	bucket: {
		multipart: {
			listUploads: (config: {
				prefix: string;
				keyMarker?: string;
				uploadIdMarker?: string;
			}) => Effect.Effect<UploadListing, E, R>;
		};
	},
	s3Key: string,
) {
	return Effect.gen(function* () {
		const reusableSince = Date.now() - OPEN_UPLOAD_REUSE_MS;
		let newest: { uploadId: string; initiatedAt: number } | null = null;
		let keyMarker: string | undefined;
		let uploadIdMarker: string | undefined;

		for (let page = 0; page < OPEN_UPLOAD_LIST_PAGES; page++) {
			const listed = yield* Effect.either(
				bucket.multipart.listUploads({
					prefix: s3Key,
					keyMarker,
					uploadIdMarker,
				}),
			);
			if (listed._tag === "Left") break;

			for (const upload of listed.right.Uploads ?? []) {
				if (upload.Key !== s3Key || !upload.UploadId || !upload.Initiated) {
					continue;
				}
				const initiatedAt = upload.Initiated.getTime();
				if (
					initiatedAt > reusableSince &&
					initiatedAt > (newest?.initiatedAt ?? 0)
				) {
					newest = { uploadId: upload.UploadId, initiatedAt };
				}
			}

			const next = listed.right.NextKeyMarker;
			if (!listed.right.IsTruncated || !next || next !== s3Key) break;
			keyMarker = next;
			uploadIdMarker = listed.right.NextUploadIdMarker;
		}

		return newest?.uploadId ?? null;
	});
}

// runPromise rejects with the failed Exit, and the storage service keeps the
// S3 error under S3Error.cause. Its name is the S3 error code.
function storageErrorCode(error: unknown): string | null {
	const failure =
		Exit.isExit(error) && Exit.isFailure(error)
			? Option.getOrNull(Cause.failureOption(error.cause))
			: error;
	if (typeof failure !== "object" || failure === null) return null;
	const cause =
		"_tag" in failure && failure._tag === "S3Error" && "cause" in failure
			? failure.cause
			: failure;
	if (typeof cause !== "object" || cause === null) return null;
	const { Code, name } = cause as { Code?: unknown; name?: unknown };
	if (typeof Code === "string") return Code;
	return typeof name === "string" ? name : null;
}

function storedObjectIsMissing(error: unknown) {
	const code = storageErrorCode(error);
	return code === "NotFound" || code === "NoSuchKey";
}

function completeRefusal(error: unknown) {
	switch (storageErrorCode(error)) {
		case "NoSuchUpload":
			return uploadNotFound(
				"The upload was aborted or the uploadId is wrong. Call initiate for a new uploadId and upload the parts again.",
			);
		case "EntityTooSmall":
			return fail(
				400,
				"part_too_small",
				"A part other than the last is under the minimum part size",
				`Every part except the last must be at least ${MIN_PART_BYTES} bytes (5 MB). Call initiate again and upload the file in larger parts.`,
			);
		case "InvalidPart":
		case "InvalidPartOrder":
			return partsMismatch();
		default:
			return null;
	}
}

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

export async function openUpload(appId: string, videoId: string) {
	const video = await findAppVideo(appId, videoId);
	if (!video || video.deletedAt) return videoNotFound();
	if (video.duration !== null) {
		return fail(
			409,
			"upload_already_completed",
			"Upload already completed",
			"This video already has its file. Create a new video to upload another one.",
		);
	}
	if (!video.s3Key) return videoNotUploadable();
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
			externalUserId: userId?.trim() || null,
			name: name ?? "Untitled",
			s3Key,
			metadata,
			playbackId,
			maxResolutionTier: maxResolutionTier ?? DEVELOPER_VIDEO_DEFAULT_TIER,
		});

	return ok({
		videoId,
		playbackId,
		...developerVideoPageUrls(playbackId, buildEnv.NEXT_PUBLIC_WEB_URL),
	});
}

export async function initiateInfraUpload({
	appId,
	videoId,
	contentType,
	contentLength,
	maxBytes,
}: {
	appId: string;
	videoId: string;
	contentType?: string;
	contentLength?: number;
	maxBytes?: number | null;
}): Promise<UploadResult<{ uploadId: string }>> {
	const upload = await openUpload(appId, videoId);
	if (upload.status !== 200) return upload;
	const { s3Key } = upload;
	const byteLimit = uploadByteLimit(maxBytes);
	if (contentLength !== undefined && contentLength > byteLimit) {
		return fileTooLarge(byteLimit, false);
	}

	const resolvedContentType =
		contentType && ALLOWED_CONTENT_TYPES.includes(contentType)
			? contentType
			: "video/mp4";

	try {
		// One request at a time per video: the row lock makes a second caller wait
		// and then find the upload the first one opened.
		const uploadId = await db().transaction(async (tx) => {
			const [current] = await tx
				.select({
					duration: developerVideos.duration,
					deletedAt: developerVideos.deletedAt,
				})
				.from(developerVideos)
				.where(eq(developerVideos.id, videoId))
				.for("update");
			if (!current || current.deletedAt || current.duration !== null) {
				return null;
			}

			return Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
				const open = yield* newestOpenUpload(bucket, s3Key);
				if (open) return open;

				const { UploadId } = yield* bucket.multipart.create(s3Key, {
					ContentType: resolvedContentType,
					CacheControl: "max-age=31536000",
				});
				if (!UploadId) throw new Error("No UploadId returned");
				return UploadId;
			}).pipe(provideOptionalAuth, runPromise);
		});

		if (uploadId === null) {
			const changed = await openUpload(appId, videoId);
			return changed.status === 200 ? videoNotUploadable() : changed;
		}
		return ok({ uploadId });
	} catch (error) {
		console.error("Error initiating multipart upload:", error);
		return storageFailure("Failed to initiate upload");
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
		return fail(
			400,
			"invalid_part_count",
			`Ask for 1 to ${MAX_PRESIGN_BATCH} parts at a time`,
			"Split the part numbers across several presign requests.",
		);
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
		return storageFailure("Failed to create presigned URL");
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
	maxBytes,
}: {
	appId: string;
	videoId: string;
	uploadId: string;
	parts: readonly UploadPart[];
	durationInSecs: number;
	width?: number;
	height?: number;
	fps?: number;
	maxBytes?: number | null;
}): Promise<UploadResult<{ success: true }>> {
	const video = await findAppVideo(appId, videoId);
	if (!video || video.deletedAt) return videoNotFound();
	if (video.duration !== null) return ok({ success: true });
	if (!video.s3Key) return videoNotUploadable();
	if (parts.length === 0) {
		return fail(
			400,
			"parts_required",
			"parts must list at least one uploaded part",
			"Send the partNumber and ETag of every part you uploaded.",
		);
	}
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
						Effect.catchAll((headError) =>
							Effect.fail(
								storedObjectIsMissing(headError) ? listError : headError,
							),
						),
					),
				),
			);
		}).pipe(provideOptionalAuth, runPromise);

		const { totalBytes } = measured;
		if (totalBytes === null) return partsMismatch();
		const byteLimit = uploadByteLimit(maxBytes);
		const tooLarge = totalBytes > byteLimit;
		if (tooLarge && !measured.assembled) {
			await discardOpenUpload(s3Key, uploadId);
			return fileTooLarge(byteLimit);
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
			return {
				...completionInProgress(
					"Another request is completing this upload. Try again shortly.",
					`Wait for the Retry-After seconds, then send the same request again. If an earlier request was cut off, this can last up to ${STALE_UPLOAD_CLAIM_MS / 60_000} minutes. Do not abort or delete.`,
				),
				headers: { "Retry-After": String(COMPLETION_RETRY_AFTER_SECONDS) },
			};
		}

		if (tooLarge) {
			await removeStoredFile(s3Key);
			await releaseDeveloperVideoUpload(videoId, claim);
			claim = null;
			return fileTooLarge(byteLimit);
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
				"upload_removed",
				"This upload was removed before it was recorded. Create a new video and upload the file again.",
				"Call create for a new video, then upload the file to it.",
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
		if (claim) {
			await releaseDeveloperVideoUpload(videoId, claim).catch(() => {});
		}
		const refusal = completeRefusal(error);
		if (refusal) {
			const recorded = await videoIsRecorded(db(), videoId).catch(() => false);
			return recorded ? ok({ success: true }) : refusal;
		}
		console.error("Error completing multipart upload:", error);
		return storageFailure("Failed to complete upload");
	}
}

// A failed abort leaves the parts for the upload cleanup, which aborts any
// upload still open a day after it was opened.
async function discardOpenUpload(s3Key: string, uploadId: string) {
	try {
		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
			yield* bucket.multipart.abort(s3Key, uploadId);
		}).pipe(provideOptionalAuth, runPromise);
	} catch (error) {
		console.error("Error aborting an oversized upload:", s3Key, error);
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
export const COMPLETION_RETRY_AFTER_SECONDS = 5;

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
	if (!video) return videoNotFound();
	if (!video.s3Key) return videoNotUploadable();
	if (video.status === "processing" && video.duration === null) {
		return completionInProgress(
			"Another request is completing this upload, so it cannot be aborted.",
			"Wait for that request to finish. The upload is then complete, so delete the video if it is not wanted.",
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
		if (storageErrorCode(error) === "NoSuchUpload") {
			return uploadNotFound(
				"Nothing was aborted. The upload was already aborted or completed, or the uploadId is wrong.",
			);
		}
		console.error("Error aborting multipart upload:", error);
		return storageFailure("Failed to abort upload");
	}
}

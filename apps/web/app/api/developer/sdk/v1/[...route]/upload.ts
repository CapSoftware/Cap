import { db } from "@cap/database";
import { developerCreditAccounts, developerVideos } from "@cap/database/schema";
import { provideOptionalAuth, S3Buckets } from "@cap/web-backend";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Hono } from "hono";
import { z } from "zod";
import { billableVideo } from "@/lib/developer-pricing";
import {
	getInfraUploadAdmission,
	uploadAdmissionError,
} from "@/lib/infra-standing";
import { runPromise } from "@/lib/server";
import { zValidator } from "@/utils/zod-validator";
import { withDeveloperPublicAuth } from "../../../../utils";

const MAX_DURATION_SECS = 4 * 60 * 60;
const STORED_BYTES_PER_SECOND = 2_500_000;
const MIN_PLAUSIBLE_BYTES_PER_SECOND = 1_000;

type StoredPart = { PartNumber?: number; ETag?: string; Size?: number };

const withoutQuotes = (etag: string | undefined) => etag?.replaceAll('"', "");

const affectedRows = (result: unknown) =>
	Array.isArray(result)
		? ((result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0)
		: ((result as { affectedRows?: number } | undefined)?.affectedRows ?? 0);

function storedBytesForParts(
	requestedParts: { partNumber: number; etag: string }[],
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

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "public";
	};
}>().use(withDeveloperPublicAuth);

app.post(
	"/initiate",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			contentType: z.string().optional(),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const { videoId, contentType } = c.req.valid("json");

		const video = await findAppVideo(appId, videoId);

		if (!video || video.deletedAt) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (video.duration !== null) {
			return c.json({ error: "Upload already completed" }, 409);
		}

		if (!video.s3Key) {
			return c.json({ error: "Video has no S3 key" }, 400);
		}

		const s3Key = video.s3Key;

		const ALLOWED_CONTENT_TYPES = [
			"video/mp4",
			"video/webm",
			"video/quicktime",
			"video/x-matroska",
			"video/avi",
			"application/octet-stream",
		];

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

			return c.json({ uploadId });
		} catch (error) {
			console.error("Error initiating multipart upload:", error);
			return c.json({ error: "Failed to initiate upload" }, 500);
		}
	},
);

app.post(
	"/presign-part",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			uploadId: z.string(),
			partNumber: z.number().int().min(1).max(10000),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const { videoId, uploadId, partNumber } = c.req.valid("json");

		const video = await findAppVideo(appId, videoId);

		if (!video || video.deletedAt) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (video.duration !== null) {
			return c.json({ error: "Upload already completed" }, 409);
		}

		if (!video.s3Key) {
			return c.json({ error: "Video has no S3 key" }, 400);
		}

		const s3Key = video.s3Key;

		try {
			const presignedUrl = await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
				return yield* bucket.multipart.getPresignedUploadPartUrl(
					s3Key,
					uploadId,
					partNumber,
				);
			}).pipe(provideOptionalAuth, runPromise);

			return c.json({ presignedUrl });
		} catch (error) {
			console.error("Error creating presigned URL:", error);
			return c.json({ error: "Failed to create presigned URL" }, 500);
		}
	},
);

app.post(
	"/complete",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			uploadId: z.string(),
			parts: z.array(
				z.object({
					partNumber: z.number().int().min(1).max(10000),
					etag: z.string(),
					size: z.number().nonnegative(),
				}),
			),
			durationInSecs: z.number().positive(),
			width: z.number().optional(),
			height: z.number().optional(),
			fps: z.number().optional(),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const { videoId, uploadId, parts, durationInSecs, width, height, fps } =
			c.req.valid("json");

		const clampedDuration = Math.min(durationInSecs, MAX_DURATION_SECS);

		const video = await findAppVideo(appId, videoId);

		if (!video || video.deletedAt) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (video.duration !== null) {
			return c.json({ success: true });
		}

		if (!video.s3Key) {
			return c.json({ error: "Video has no S3 key" }, 400);
		}

		const s3Key = video.s3Key;

		try {
			const storedParts = await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
				return yield* bucket.multipart.listParts(s3Key, uploadId);
			}).pipe(provideOptionalAuth, runPromise);

			const totalBytes = storedBytesForParts(parts, storedParts);
			if (totalBytes === null) {
				return c.json(
					{ error: "Uploaded parts do not match the request" },
					400,
				);
			}
			const plausibleDuration = Math.min(
				clampedDuration,
				totalBytes / MIN_PLAUSIBLE_BYTES_PER_SECOND,
			);
			const sizeBasedMinDuration = totalBytes / STORED_BYTES_PER_SECOND;
			const storedDuration = Math.min(
				Math.max(plausibleDuration, sizeBasedMinDuration),
				MAX_DURATION_SECS,
			);
			const updates: Partial<typeof developerVideos.$inferInsert> = {
				duration: storedDuration,
			};
			if (width !== undefined) updates.width = width;
			if (height !== undefined) updates.height = height;
			if (fps !== undefined) updates.fps = fps;

			const { admission, stored } = await db().transaction(async (tx) => {
				await tx
					.select({ id: developerCreditAccounts.id })
					.from(developerCreditAccounts)
					.where(eq(developerCreditAccounts.appId, appId))
					.limit(1)
					.for("update");

				const admission = await getInfraUploadAdmission(
					appId,
					billableVideo({ duration: storedDuration, width, height }),
				);
				if (!admission.allowed) return { admission, stored: false };

				const result = await tx
					.update(developerVideos)
					.set(updates)
					.where(
						and(
							eq(developerVideos.id, videoId),
							isNull(developerVideos.duration),
						),
					);
				return { admission, stored: affectedRows(result) > 0 };
			});

			if (!admission.allowed) {
				return c.json(uploadAdmissionError(admission), 402);
			}
			if (!stored) {
				return c.json({ success: true });
			}

			try {
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
			} catch (error) {
				await db()
					.update(developerVideos)
					.set({ duration: null })
					.where(eq(developerVideos.id, videoId));
				throw error;
			}

			return c.json({ success: true });
		} catch (error) {
			console.error("Error completing multipart upload:", error);
			return c.json({ error: "Failed to complete upload" }, 500);
		}
	},
);

app.post(
	"/abort",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			uploadId: z.string(),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const { videoId, uploadId } = c.req.valid("json");

		const video = await findAppVideo(appId, videoId);

		if (!video) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (!video.s3Key) {
			return c.json({ error: "Video has no S3 key" }, 400);
		}

		const s3Key = video.s3Key;

		try {
			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
				yield* bucket.multipart.abort(s3Key, uploadId);
			}).pipe(provideOptionalAuth, runPromise);

			return c.json({ success: true });
		} catch (error) {
			console.error("Error aborting multipart upload:", error);
			return c.json({ error: "Failed to abort upload" }, 500);
		}
	},
);

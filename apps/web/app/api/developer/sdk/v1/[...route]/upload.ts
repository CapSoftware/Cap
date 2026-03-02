import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerCreditAccounts,
	developerCreditTransactions,
	developerVideos,
} from "@cap/database/schema";
import { provideOptionalAuth, S3Buckets } from "@cap/web-backend";
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";
import { runPromise } from "@/lib/server";
import { withDeveloperPublicAuth } from "../../../../utils";

const MICRO_CREDITS_PER_MINUTE = 5_000;

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

		const [video] = await db()
			.select()
			.from(developerVideos)
			.where(eq(developerVideos.id, videoId))
			.limit(1);

		if (!video || video.appId !== appId) {
			return c.json({ error: "Video not found" }, 404);
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
				const [bucket] = yield* S3Buckets.getBucketAccess();
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
			partNumber: z.number(),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const { videoId, uploadId, partNumber } = c.req.valid("json");

		const [video] = await db()
			.select()
			.from(developerVideos)
			.where(eq(developerVideos.id, videoId))
			.limit(1);

		if (!video || video.appId !== appId) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (!video.s3Key) {
			return c.json({ error: "Video has no S3 key" }, 400);
		}

		const s3Key = video.s3Key;

		try {
			const presignedUrl = await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess();
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
					partNumber: z.number(),
					etag: z.string(),
					size: z.number(),
				}),
			),
			durationInSecs: z.number().optional(),
			width: z.number().optional(),
			height: z.number().optional(),
			fps: z.number().optional(),
		}),
	),
	async (c) => {
		const appId = c.get("developerAppId");
		const { videoId, uploadId, parts, durationInSecs, width, height, fps } =
			c.req.valid("json");

		const [video] = await db()
			.select()
			.from(developerVideos)
			.where(eq(developerVideos.id, videoId))
			.limit(1);

		if (!video || video.appId !== appId) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (!video.s3Key) {
			return c.json({ error: "Video has no S3 key" }, 400);
		}

		const s3Key = video.s3Key;

		try {
			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess();

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

			const updates: Record<string, unknown> = {};
			if (durationInSecs !== undefined) updates.duration = durationInSecs;
			if (width !== undefined) updates.width = width;
			if (height !== undefined) updates.height = height;
			if (fps !== undefined) updates.fps = fps;

			if (Object.keys(updates).length > 0) {
				await db()
					.update(developerVideos)
					.set(updates)
					.where(eq(developerVideos.id, videoId));
			}

			if (durationInSecs && durationInSecs > 0) {
				const durationMinutes = durationInSecs / 60;
				const microCreditsToDebit = Math.floor(
					durationMinutes * MICRO_CREDITS_PER_MINUTE,
				);

				const [account] = await db()
					.select()
					.from(developerCreditAccounts)
					.where(eq(developerCreditAccounts.appId, appId))
					.limit(1);

				if (account && microCreditsToDebit > 0) {
					await db().transaction(async (tx) => {
						await tx
							.update(developerCreditAccounts)
							.set({
								balanceMicroCredits: sql`${developerCreditAccounts.balanceMicroCredits} - ${microCreditsToDebit}`,
							})
							.where(
								and(
									eq(developerCreditAccounts.id, account.id),
									sql`${developerCreditAccounts.balanceMicroCredits} >= ${microCreditsToDebit}`,
								),
							);

						const [updated] = await tx
							.select({
								balanceMicroCredits:
									developerCreditAccounts.balanceMicroCredits,
							})
							.from(developerCreditAccounts)
							.where(eq(developerCreditAccounts.id, account.id))
							.limit(1);

						await tx.insert(developerCreditTransactions).values({
							id: nanoId(),
							accountId: account.id,
							type: "video_create",
							amountMicroCredits: -microCreditsToDebit,
							balanceAfterMicroCredits: updated.balanceMicroCredits,
							referenceId: videoId,
							referenceType: "developer_video",
							metadata: { durationSeconds: durationInSecs },
						});
					});
				}
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

		const [video] = await db()
			.select()
			.from(developerVideos)
			.where(eq(developerVideos.id, videoId))
			.limit(1);

		if (!video || video.appId !== appId) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (!video.s3Key) {
			return c.json({ error: "Video has no S3 key" }, 400);
		}

		const s3Key = video.s3Key;

		try {
			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess();
				const multipart = bucket.multipart as typeof bucket.multipart & {
					abort: (key: string, uploadId: string) => Effect.Effect<void>;
				};
				yield* multipart.abort(s3Key, uploadId);
			}).pipe(provideOptionalAuth, runPromise);

			return c.json({ success: true });
		} catch (error) {
			console.error("Error aborting multipart upload:", error);
			return c.json({ error: "Failed to abort upload" }, 500);
		}
	},
);

import { db } from "@cap/database";
import { hashPassword } from "@cap/database/crypto";
import { sendEmail } from "@cap/database/emails/config";
import { FirstShareableLink } from "@cap/database/emails/first-shareable-link";
import { nanoId } from "@cap/database/helpers";
import {
	importedVideos,
	organizationMembers,
	organizations,
	s3Buckets,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub, userIsPro } from "@cap/utils";
import { S3Buckets } from "@cap/web-backend";
import { Organisation, Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, lte, or } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Hono } from "hono";
import { z } from "zod";
import { runPromise } from "@/lib/server";
import { isFromDesktopSemver, UPLOAD_PROGRESS_VERSION } from "@/utils/desktop";
import { stringOrNumberOptional } from "@/utils/zod";
import { withAuth } from "../../utils";
import type { VideoMetadata } from "@cap/database/types/metadata";

export const app = new Hono().use(withAuth);

app.get(
	"/create",
	zValidator(
		"query",
		z.object({
			recordingMode: z
				.union([z.literal("hls"), z.literal("desktopMP4")])
				.optional(),
			isScreenshot: z.coerce.boolean().default(false),
			videoId: z.string().optional(),
			name: z.string().optional(),
			durationInSecs: stringOrNumberOptional,
			width: stringOrNumberOptional,
			height: stringOrNumberOptional,
			fps: stringOrNumberOptional,
			orgId: z
				.string()
				.optional()
				.transform((v) =>
					v ? Organisation.OrganisationId.make(v) : undefined,
				),
		}),
	),
	async (c) => {
		try {
			const {
				recordingMode,
				isScreenshot,
				videoId,
				name,
				durationInSecs,
				width,
				height,
				fps,
				orgId,
			} = c.req.valid("query");
			const user = c.get("user");

			const isCapPro = userIsPro(user);

			if (!isCapPro && durationInSecs && durationInSecs > /* 5 min */ 5 * 60)
				return c.json({ error: "upgrade_required" }, { status: 403 });

			console.log("Video create request:", {
				recordingMode,
				isScreenshot,
				videoId,
				userId: user.id,
				durationInSecs,
				height,
				width,
				fps,
			});

			const [customBucket] = await db()
				.select()
				.from(s3Buckets)
				.where(eq(s3Buckets.ownerId, user.id));

			const date = new Date();
			const formattedDate = `${date.getDate()} ${date.toLocaleString(
				"default",
				{ month: "long" },
			)} ${date.getFullYear()}`;

			if (videoId !== undefined) {
				const [video] = await db()
					.select()
					.from(videos)
					.where(eq(videos.id, Video.VideoId.make(videoId)));

				if (video)
					return c.json({
						id: video.id,
						// All deprecated
						user_id: user.id,
						aws_region: "n/a",
						aws_bucket: "n/a",
					});
			}

			const userOrganizations = await db()
				.select({
					id: organizations.id,
					name: organizations.name,
				})
				.from(organizations)
				.leftJoin(
					organizationMembers,
					eq(organizations.id, organizationMembers.organizationId),
				)
				.where(
					or(
						// User owns the organization
						eq(organizations.ownerId, user.id),
						// User is a member of the organization
						eq(organizationMembers.userId, user.id),
					),
				)
				// Remove duplicates if user is both owner and member
				.groupBy(organizations.id, organizations.name)
				.orderBy(organizations.createdAt);
			const userOrgIds = userOrganizations.map((org) => org.id);

			let videoOrgId: Organisation.OrganisationId;
			if (orgId) {
				// Hard error if the user requested org is non-existent or they don't have access.
				if (!userOrgIds.includes(orgId))
					return c.json({ error: "forbidden_org" }, { status: 403 });
				videoOrgId = orgId;
			} else if (user.defaultOrgId) {
				// User's defaultOrgId is no longer valid, switch to first available org
				if (!userOrgIds.includes(user.defaultOrgId)) {
					if (!userOrganizations[0])
						return c.json({ error: "no_valid_org" }, { status: 403 });

					videoOrgId = userOrganizations[0].id;

					// Update user's defaultOrgId to the new valid org
					await db()
						.update(users)
						.set({
							defaultOrgId: videoOrgId,
						})
						.where(eq(users.id, user.id));
				} else videoOrgId = user.defaultOrgId;
			} else {
				// No orgId provided and no defaultOrgId, use first available org
				if (!userOrganizations[0])
					return c.json({ error: "no_valid_org" }, { status: 403 });
				videoOrgId = userOrganizations[0].id;
			}

			const idToUse = Video.VideoId.make(nanoId());

			const videoName =
				name ??
				`Cap ${isScreenshot ? "Screenshot" : "Recording"} - ${formattedDate}`;

			await db()
				.insert(videos)
				.values({
					id: idToUse,
					name: videoName,
					ownerId: user.id,
					orgId: videoOrgId,
					source:
						recordingMode === "hls"
							? { type: "local" as const }
							: recordingMode === "desktopMP4"
								? { type: "desktopMP4" as const }
								: undefined,
					isScreenshot,
					bucket: customBucket?.id,
					public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
					duration: durationInSecs,
					width,
					height,
					fps,
				});

			const clientSupportsUploadProgress = isFromDesktopSemver(
				c.req,
				UPLOAD_PROGRESS_VERSION,
			);

			if (clientSupportsUploadProgress)
				await db().insert(videoUploads).values({
					videoId: idToUse,
					mode: "singlepart",
				});

			if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production")
				await dub().links.create({
					url: `${serverEnv().WEB_URL}/s/${idToUse}`,
					domain: "cap.link",
					key: idToUse,
				});

			try {
				const videoCount = await db()
					.select({ count: count() })
					.from(videos)
					.where(eq(videos.ownerId, user.id));

				if (videoCount?.[0] && videoCount[0].count === 1 && user.email) {
					console.log(
						"[SendFirstShareableLinkEmail] Sending first shareable link email with 5-minute delay",
					);

					const videoUrl = buildEnv.NEXT_PUBLIC_IS_CAP
						? `https://cap.link/${idToUse}`
						: `${serverEnv().WEB_URL}/s/${idToUse}`;

					await sendEmail({
						email: user.email,
						subject: "You created your first Cap! 🥳",
						react: FirstShareableLink({
							email: user.email,
							url: videoUrl,
							videoName: videoName,
						}),
						marketing: true,
						scheduledAt: "in 5 min",
					});

					console.log(
						"[SendFirstShareableLinkEmail] First shareable link email scheduled to be sent in 5 minutes",
					);
				}
			} catch (error) {
				console.error(
					"Error checking for first video or sending email:",
					error,
				);
			}

			return c.json({
				id: idToUse,
				// All deprecated
				user_id: user.id,
				aws_region: "n/a",
				aws_bucket: "n/a",
			});
		} catch (error) {
			console.error("Error in video create endpoint:", error);
			return c.json({ error: "Internal server error" }, { status: 500 });
		}
	},
);

app.delete(
	"/delete",
	zValidator("query", z.object({ videoId: z.string() })),
	async (c) => {
		const videoId = Video.VideoId.make(c.req.valid("query").videoId);
		const user = c.get("user");

		try {
			const [result] = await db()
				.select({ video: videos, bucket: s3Buckets })
				.from(videos)
				.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
				.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));

			if (!result)
				return c.json(
					{ error: true, message: "Video not found" },
					{ status: 404 },
				);

			await db().delete(videoUploads).where(eq(videoUploads.videoId, videoId));
			await db().delete(importedVideos).where(eq(importedVideos.id, videoId));

			await db()
				.delete(videos)
				.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));

			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(
					Option.fromNullable(result.bucket?.id),
				);

				const listedObjects = yield* bucket.listObjects({
					prefix: `${user.id}/${videoId}/`,
				});

				if (listedObjects.Contents)
					yield* bucket.deleteObjects(
						listedObjects.Contents.map((content: any) => ({
							Key: content.Key,
						})),
					);
			}).pipe(runPromise);

			return c.json(true);
		} catch (error) {
			console.error("Error in video delete endpoint:", error);
			return c.json({ error: "Internal server error" }, { status: 500 });
		}
	},
);

app.post(
	"/progress",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			uploaded: z.number(),
			total: z.number(),
			// We get this from the client so we can avoid race conditions.
			// Eg. If this value is older than the value in the DB, we ignore it.
			updatedAt: z.string().pipe(z.coerce.date()),
		}),
	),
	async (c) => {
		const {
			videoId: videoIdRaw,
			uploaded: uploadedRaw,
			total,
			updatedAt,
		} = c.req.valid("json");
		const user = c.get("user");
		const videoId = Video.VideoId.make(videoIdRaw);

		// Prevent it maths breaking
		const uploaded = Math.min(uploadedRaw, total);

		try {
			const [video] = await db()
				.select({ id: videos.id, upload: videoUploads })
				.from(videos)
				.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)))
				.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId));
			if (!video)
				return c.json(
					{ error: true, message: "Video not found" },
					{ status: 404 },
				);

			if (video.upload) {
				if (uploaded === total && video.upload.mode !== "multipart") {
					await db()
						.delete(videoUploads)
						.where(eq(videoUploads.videoId, videoId));
				} else {
					await db()
						.update(videoUploads)
						.set({
							uploaded,
							total,
							updatedAt,
						})
						.where(
							and(
								eq(videoUploads.videoId, videoId),
								lte(videoUploads.updatedAt, updatedAt),
							),
						);
				}
			} else {
				await db().insert(videoUploads).values({
					videoId,
					uploaded,
					total,
					updatedAt,
				});
			}

			return c.json(true);
		} catch (error) {
			console.error("Error in progress update endpoint:", error);
			return c.json({ error: "Internal server error" }, { status: 500 });
		}
	},
);

app.get(
	"/info",
	zValidator("query", z.object({ videoId: z.string() })),
	async (c) => {
		const videoId = Video.VideoId.make(c.req.valid("query").videoId);
		const user = c.get("user");

		const [result] = await db()
			.select()
			.from(videos)
			.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));

		if (!result)
			return c.json({ error: "Video not found" }, { status: 404 });

		const meta = (result.metadata ?? {}) as VideoMetadata;

		return c.json({
			id: result.id,
			name: result.name,
			createdAt: result.createdAt,
			duration: result.duration,
			width: result.width,
			height: result.height,
			public: result.public,
			hasPassword: result.password !== null,
			transcriptionStatus: result.transcriptionStatus,
			aiTitle: meta.aiTitle ?? null,
			summary: meta.summary ?? null,
			chapters: meta.chapters ?? null,
		});
	},
);

app.get(
	"/transcript",
	zValidator("query", z.object({ videoId: z.string() })),
	async (c) => {
		const videoId = Video.VideoId.make(c.req.valid("query").videoId);
		const user = c.get("user");

		const [result] = await db()
			.select({ video: videos, bucket: s3Buckets })
			.from(videos)
			.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
			.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));

		if (!result?.video)
			return c.json({ error: "Video not found" }, { status: 404 });

		if (result.video.transcriptionStatus !== "COMPLETE")
			return c.json({
				error: "Transcript not ready",
				status: result.video.transcriptionStatus,
			}, { status: 404 });

		try {
			const vttContent = await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(
					Option.fromNullable(result.bucket?.id),
				);
				return yield* bucket.getObject(
					`${result.video.ownerId}/${videoId}/transcription.vtt`,
				);
			}).pipe(runPromise);

			if (Option.isNone(vttContent))
				return c.json({ error: "Transcript file not found" }, { status: 404 });

			return c.json({ content: vttContent.value });
		} catch (error) {
			console.error("Error fetching transcript:", error);
			return c.json({ error: "Failed to fetch transcript" }, { status: 500 });
		}
	},
);

app.post(
	"/password",
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			password: z.string().nullable(),
		}),
	),
	async (c) => {
		const { videoId: videoIdRaw, password } = c.req.valid("json");
		const videoId = Video.VideoId.make(videoIdRaw);
		const user = c.get("user");

		const [video] = await db()
			.select()
			.from(videos)
			.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));

		if (!video)
			return c.json({ error: "Video not found" }, { status: 404 });

		if (password === null) {
			await db()
				.update(videos)
				.set({ password: null })
				.where(eq(videos.id, videoId));
			return c.json({ success: true, message: "Password removed" });
		}

		const hashed = await hashPassword(password);
		await db()
			.update(videos)
			.set({ password: hashed })
			.where(eq(videos.id, videoId));

		return c.json({ success: true, message: "Password set" });
	},
);

app.get(
	"/list",
	zValidator(
		"query",
		z.object({
			orgId: z.string().optional(),
			limit: z.coerce.number().int().min(1).max(100).default(20),
			offset: z.coerce.number().int().min(0).default(0),
		}),
	),
	async (c) => {
		const { orgId, limit, offset } = c.req.valid("query");
		const user = c.get("user");

		const conditions = [eq(videos.ownerId, user.id)];

		if (orgId) {
			conditions.push(eq(videos.orgId, Organisation.OrganisationId.make(orgId)));
		}

		const whereClause = and(...conditions);

		const [data, countResult] = await Promise.all([
			db()
				.select({
					id: videos.id,
					name: videos.name,
					createdAt: videos.createdAt,
					duration: videos.duration,
					hasPassword: videos.password,
					transcriptionStatus: videos.transcriptionStatus,
				})
				.from(videos)
				.where(whereClause)
				.orderBy(desc(videos.createdAt))
				.limit(limit)
				.offset(offset),
			db()
				.select({ total: count() })
				.from(videos)
				.where(whereClause),
		]);

		return c.json({
			data: data.map((v) => ({
				...v,
				hasPassword: v.hasPassword !== null,
			})),
			total: countResult[0]?.total ?? 0,
		});
	},
);

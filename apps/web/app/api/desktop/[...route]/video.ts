import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { FirstShareableLink } from "@cap/database/emails/first-shareable-link";
import { nanoId } from "@cap/database/helpers";
import { s3Buckets, videos, videoUploads } from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import { Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, gt, gte, lt, lte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dub } from "@/utils/dub";
import { createBucketProvider } from "@/utils/s3";
import { stringOrNumberOptional } from "@/utils/zod";
import { withAuth } from "../../utils";

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

			console.log("User bucket:", customBucket ? "found" : "not found");

			const bucket = await createBucketProvider(customBucket);

			const date = new Date();
			const formattedDate = `${date.getDate()} ${date.toLocaleString(
				"default",
				{ month: "long" },
			)} ${date.getFullYear()}`;

			if (videoId !== undefined) {
				const [video] = await db()
					.select()
					.from(videos)
					.where(eq(videos.id, videoId));

				if (video) {
					return c.json({
						id: video.id,
						// All deprecated
						user_id: user.id,
						aws_region: "n/a",
						aws_bucket: "n/a",
					});
				}
			}

			const idToUse = nanoId();

			const videoName =
				name ??
				`Cap ${isScreenshot ? "Screenshot" : "Recording"} - ${formattedDate}`;

			await db()
				.insert(videos)
				.values({
					id: idToUse,
					name: videoName,
					ownerId: user.id,
					awsRegion: "auto",
					awsBucket: bucket.name,
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

			const xCapVersion = c.req.header("X-Cap-Desktop-Version");
			const clientSupportsUploadProgress = xCapVersion
				? isAtLeastSemver(xCapVersion, 0, 3, 68)
				: false;

			if (clientSupportsUploadProgress)
				await db().insert(videoUploads).values({
					videoId: idToUse,
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

				if (
					videoCount &&
					videoCount[0] &&
					videoCount[0].count === 1 &&
					user.email
				) {
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
		const { videoId } = c.req.valid("query");
		const user = c.get("user");

		try {
			const [result] = await db()
				.select({ video: videos, bucket: s3Buckets })
				.from(videos)
				.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
				.where(eq(videos.id, videoId));

			if (!result)
				return c.json(
					{ error: true, message: "Video not found" },
					{ status: 404 },
				);

			await db().delete(videoUploads).where(eq(videoUploads.videoId, videoId));

			await db()
				.delete(videos)
				.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));

			const bucket = await createBucketProvider(result.bucket);

			const listedObjects = await bucket.listObjects({
				prefix: `${user.id}/${videoId}/`,
			});

			if (listedObjects.Contents?.length)
				await bucket.deleteObjects(
					listedObjects.Contents.map((content: any) => ({
						Key: content.Key,
					})),
				);

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
				.select({ id: videos.id })
				.from(videos)
				.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));
			if (!video)
				return c.json(
					{ error: true, message: "Video not found" },
					{ status: 404 },
				);

			const result = await db()
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

			if (result.rowsAffected === 0)
				await db().insert(videoUploads).values({
					videoId,
					uploaded,
					total,
					updatedAt,
				});

			if (uploaded === total)
				await db()
					.delete(videoUploads)
					.where(eq(videoUploads.videoId, videoId));

			return c.json(true);
		} catch (error) {
			console.error("Error in progress update endpoint:", error);
			return c.json({ error: "Internal server error" }, { status: 500 });
		}
	},
);

function isAtLeastSemver(
	versionString: string,
	major: number,
	minor: number,
	patch: number,
): boolean {
	const match = versionString
		.replace(/^v/, "")
		.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/);
	if (!match) return false;
	const [, vMajor, vMinor, vPatch, prerelease] = match;
	const M = vMajor ? parseInt(vMajor, 10) || 0 : 0;
	const m = vMinor ? parseInt(vMinor, 10) || 0 : 0;
	const p = vPatch ? parseInt(vPatch, 10) || 0 : 0;
	if (M > major) return true;
	if (M < major) return false;
	if (m > minor) return true;
	if (m < minor) return false;
	if (p > patch) return true;
	if (p < patch) return false;
	// Equal triplet: accept only non-prerelease
	return !prerelease;
}

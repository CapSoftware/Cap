import { db } from "@cap/database";
import * as Db from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
	DesktopRecordingSourceBlockedError,
	SourceCommitPendingError,
} from "@/lib/desktop-recording-jobs";
import {
	validateDesktopRecordingRequest,
	verifyDesktopRecordingUpload,
} from "@/lib/desktop-recording-upload-status";
import { recordingVerificationSchema } from "@/lib/desktop-recording-verification";
import { queueDesktopSegmentsFinalization } from "@/lib/desktop-segments-finalization";
import { withAuth } from "../../utils";

export const app = new Hono().post(
	"/",
	withAuth,
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
			verification: recordingVerificationSchema.optional(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { videoId: videoIdRaw, verification } = c.req.valid("json");
		const videoId = Video.VideoId.make(videoIdRaw);

		const [video] = await db()
			.select()
			.from(Db.videos)
			.where(and(eq(Db.videos.id, videoId), eq(Db.videos.ownerId, user.id)));

		if (!video) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (
			video.source?.type !== "desktopMP4" &&
			video.source?.type !== "desktopSegments"
		) {
			return c.json({ error: "Video is not a desktop recording" }, 400);
		}

		try {
			if (verification) {
				const receipt =
					video.source.type === "desktopMP4"
						? await verifyDesktopRecordingUpload(video, verification)
						: null;
				if (receipt) {
					return c.json({
						success: true,
						status: "verified",
						verification: receipt,
					});
				}
				await validateDesktopRecordingRequest(video, verification);
			}
			const status = await queueDesktopSegmentsFinalization({
				videoId,
				userId: user.id,
				verification,
			});
			return c.json({ success: true, status });
		} catch (error) {
			if (error instanceof DesktopRecordingSourceBlockedError) {
				return c.json(
					{
						success: false,
						status: "reupload-required",
						code: error.code,
						error: error.message,
					},
					409,
				);
			}
			c.header("Retry-After", "5");
			if (error instanceof SourceCommitPendingError) {
				return c.json(
					{ success: false, status: error.code, error: error.message },
					503,
				);
			}
			console.error("[recording-complete] Finalization unavailable:", error);
			return c.json(
				{
					success: false,
					error:
						"Recording verification is unavailable; retain the local recording. Processing will retry automatically.",
				},
				503,
			);
		}
	},
);

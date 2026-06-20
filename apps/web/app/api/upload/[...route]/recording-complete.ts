import { db } from "@cap/database";
import * as Db from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { queueDesktopSegmentsFinalization } from "@/lib/desktop-segments-finalization";
import { withAuth } from "../../utils";

export const app = new Hono().post(
	"/",
	withAuth,
	zValidator(
		"json",
		z.object({
			videoId: z.string(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { videoId: videoIdRaw } = c.req.valid("json");
		const videoId = Video.VideoId.make(videoIdRaw);

		const [video] = await db()
			.select()
			.from(Db.videos)
			.where(and(eq(Db.videos.id, videoId), eq(Db.videos.ownerId, user.id)));

		if (!video) {
			return c.json({ error: "Video not found" }, 404);
		}

		if (video.source?.type === "desktopMP4") {
			return c.json({ success: true, status: "already-complete" });
		}

		if (video.source?.type !== "desktopSegments") {
			return c.json({ error: "Video is not a segmented recording" }, 400);
		}

		try {
			const status = await queueDesktopSegmentsFinalization({
				videoId,
				userId: user.id,
			});

			return c.json({ success: true, status });
		} catch (error) {
			console.error("[recording-complete] Error queueing mux:", error);
			return c.json({ error: "Failed to queue muxing" }, 500);
		}
	},
);

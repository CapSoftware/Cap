import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { withDeveloperSecretAuth } from "../../../utils";

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "secret";
	};
}>().use(withDeveloperSecretAuth);

app.get("/", async (c) => {
	const appId = c.get("developerAppId");
	const userId = c.req.query("userId");
	const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 100);
	const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);

	const conditions = [
		eq(developerVideos.appId, appId),
		isNull(developerVideos.deletedAt),
	];

	if (userId) {
		conditions.push(eq(developerVideos.externalUserId, userId));
	}

	const videos = await db()
		.select()
		.from(developerVideos)
		.where(and(...conditions))
		.orderBy(desc(developerVideos.createdAt))
		.limit(limit)
		.offset(offset);

	return c.json({ data: videos });
});

app.get("/:id", async (c) => {
	const appId = c.get("developerAppId");
	const videoId = c.req.param("id");

	const [video] = await db()
		.select()
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos.id, videoId),
				eq(developerVideos.appId, appId),
				isNull(developerVideos.deletedAt),
			),
		)
		.limit(1);

	if (!video) {
		return c.json({ error: "Video not found" }, 404);
	}

	return c.json({ data: video });
});

app.delete("/:id", async (c) => {
	const appId = c.get("developerAppId");
	const videoId = c.req.param("id");

	const [video] = await db()
		.select()
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos.id, videoId),
				eq(developerVideos.appId, appId),
				isNull(developerVideos.deletedAt),
			),
		)
		.limit(1);

	if (!video) {
		return c.json({ error: "Video not found" }, 404);
	}

	await db()
		.update(developerVideos)
		.set({ deletedAt: new Date() })
		.where(eq(developerVideos.id, videoId));

	return c.json({ success: true });
});

app.get("/:id/status", async (c) => {
	const appId = c.get("developerAppId");
	const videoId = c.req.param("id");

	const [video] = await db()
		.select({
			id: developerVideos.id,
			duration: developerVideos.duration,
			width: developerVideos.width,
			height: developerVideos.height,
			transcriptionStatus: developerVideos.transcriptionStatus,
		})
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos.id, videoId),
				eq(developerVideos.appId, appId),
				isNull(developerVideos.deletedAt),
			),
		)
		.limit(1);

	if (!video) {
		return c.json({ error: "Video not found" }, 404);
	}

	const ready = video.duration !== null && video.width !== null;

	return c.json({
		data: {
			...video,
			ready,
		},
	});
});

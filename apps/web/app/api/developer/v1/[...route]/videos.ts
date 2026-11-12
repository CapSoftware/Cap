import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { apiErrorBody } from "@/lib/api-errors";
import { parseDeveloperListQuery } from "@/lib/developer-pagination";
import {
	serializeDeveloperVideo,
	serializeDeveloperVideoStatus,
} from "@/lib/developer-video-api";
import { redriveDeveloperVideoProcessing } from "@/lib/developer-video-start";
import { developerVideoRedrive } from "@/lib/developer-video-state";
import { withDeveloperSecretAuth } from "../../../utils";

async function findAppVideo(appId: string, videoId: string) {
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
	return video ?? null;
}

async function findAppVideoAndRedrive(appId: string, videoId: string) {
	const video = await findAppVideo(appId, videoId);
	if (!video || !developerVideoRedrive(video, Date.now())) return video;
	const started = await redriveDeveloperVideoProcessing(videoId);
	return started ? findAppVideo(appId, videoId) : video;
}

const videoNotFound = apiErrorBody(
	"video_not_found",
	"Video not found",
	"Check the video ID and that it belongs to this app. Deleted videos are not returned.",
);

const LIST_FILTERS = ["userId", "externalUserId"];

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "secret";
	};
}>().use(withDeveloperSecretAuth);

app.get("/", async (c) => {
	const appId = c.get("developerAppId");
	const query = c.req.query();
	const parsed = parseDeveloperListQuery(query, LIST_FILTERS);
	if (!parsed.ok) {
		return c.json(apiErrorBody(parsed.code, parsed.message, parsed.hint), 400);
	}
	const { limit, offset } = parsed;
	if (
		query.userId !== undefined &&
		query.externalUserId !== undefined &&
		query.userId !== query.externalUserId
	) {
		return c.json(
			apiErrorBody(
				"conflicting_parameters",
				"userId and externalUserId name the same filter",
				"Send one of them, or the same value in both.",
			),
			400,
		);
	}
	const userId = query.userId ?? query.externalUserId;

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

	return c.json({ data: videos.map(serializeDeveloperVideo) });
});

app.get("/:id", async (c) => {
	const video = await findAppVideoAndRedrive(
		c.get("developerAppId"),
		c.req.param("id"),
	);

	if (!video) {
		return c.json(videoNotFound, 404);
	}

	return c.json({ data: serializeDeveloperVideo(video) });
});

app.delete("/:id", async (c) => {
	const appId = c.get("developerAppId");
	const videoId = c.req.param("id");

	const [video] = await db()
		.select({ deletedAt: developerVideos.deletedAt })
		.from(developerVideos)
		.where(
			and(eq(developerVideos.id, videoId), eq(developerVideos.appId, appId)),
		)
		.limit(1);

	if (!video) {
		return c.json(videoNotFound, 404);
	}

	if (!video.deletedAt) {
		await db()
			.update(developerVideos)
			.set({ deletedAt: new Date() })
			.where(eq(developerVideos.id, videoId));
	}

	return c.json({ success: true });
});

app.get("/:id/status", async (c) => {
	const video = await findAppVideoAndRedrive(
		c.get("developerAppId"),
		c.req.param("id"),
	);

	if (!video) {
		return c.json(videoNotFound, 404);
	}

	return c.json({ data: serializeDeveloperVideoStatus(video) });
});

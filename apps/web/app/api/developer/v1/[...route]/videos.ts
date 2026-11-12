import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { apiErrorBody } from "@/lib/api-errors";
import { parseDeveloperListQuery } from "@/lib/developer-pagination";
import {
	exactUserIdMatch,
	parseDeveloperUserScope,
	parseDeveloperVideoScope,
	USER_SCOPE_PARAMETERS,
} from "@/lib/developer-user-scope";
import {
	serializeDeveloperVideo,
	serializeDeveloperVideoStatus,
} from "@/lib/developer-video-api";
import { redriveDeveloperVideoProcessing } from "@/lib/developer-video-start";
import { developerVideoRedrive } from "@/lib/developer-video-state";
import { withDeveloperSecretAuth } from "../../../utils";

const ownedBy = (userId: string | undefined) =>
	userId === undefined
		? undefined
		: exactUserIdMatch(developerVideos.externalUserId, userId);

async function findAppVideo(
	appId: string,
	videoId: string,
	userId: string | undefined,
) {
	const [video] = await db()
		.select()
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos.id, videoId),
				eq(developerVideos.appId, appId),
				isNull(developerVideos.deletedAt),
				ownedBy(userId),
			),
		)
		.limit(1);
	return video ?? null;
}

async function findAppVideoAndRedrive(
	appId: string,
	videoId: string,
	userId: string | undefined,
) {
	const video = await findAppVideo(appId, videoId, userId);
	if (!video || !developerVideoRedrive(video, Date.now())) return video;
	const started = await redriveDeveloperVideoProcessing(videoId);
	return started ? findAppVideo(appId, videoId, userId) : video;
}

const videoNotFound = (userId: string | undefined) =>
	apiErrorBody(
		"video_not_found",
		"Video not found",
		userId === undefined
			? "Check the video ID and that it belongs to this app. Deleted videos are not returned."
			: "Check the video ID and that it belongs to this app and was created with this userId. Deleted videos are not returned.",
	);

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "secret";
	};
}>().use(withDeveloperSecretAuth);

app.get("/", async (c) => {
	const appId = c.get("developerAppId");
	const query = c.req.query();
	const parsed = parseDeveloperListQuery(query, USER_SCOPE_PARAMETERS);
	if (!parsed.ok) {
		return c.json(apiErrorBody(parsed.code, parsed.message, parsed.hint), 400);
	}
	const { limit, offset } = parsed;
	const scope = parseDeveloperUserScope(c.req.queries());
	if (!scope.ok) {
		return c.json(apiErrorBody(scope.code, scope.message, scope.hint), 400);
	}

	const videos = await db()
		.select()
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos.appId, appId),
				isNull(developerVideos.deletedAt),
				ownedBy(scope.userId),
			),
		)
		.orderBy(desc(developerVideos.createdAt), desc(developerVideos.id))
		.limit(limit + 1)
		.offset(offset);

	return c.json({
		data: videos.slice(0, limit).map(serializeDeveloperVideo),
		pagination: { limit, offset, hasMore: videos.length > limit },
	});
});

app.get("/:id", async (c) => {
	const scope = parseDeveloperVideoScope(c.req.queries());
	if (!scope.ok) {
		return c.json(apiErrorBody(scope.code, scope.message, scope.hint), 400);
	}
	const video = await findAppVideoAndRedrive(
		c.get("developerAppId"),
		c.req.param("id"),
		scope.userId,
	);

	if (!video) {
		return c.json(videoNotFound(scope.userId), 404);
	}

	return c.json({ data: serializeDeveloperVideo(video) });
});

app.delete("/:id", async (c) => {
	const appId = c.get("developerAppId");
	const videoId = c.req.param("id");
	const scope = parseDeveloperVideoScope(c.req.queries());
	if (!scope.ok) {
		return c.json(apiErrorBody(scope.code, scope.message, scope.hint), 400);
	}

	const [video] = await db()
		.select({ deletedAt: developerVideos.deletedAt })
		.from(developerVideos)
		.where(
			and(
				eq(developerVideos.id, videoId),
				eq(developerVideos.appId, appId),
				ownedBy(scope.userId),
			),
		)
		.limit(1);

	if (!video) {
		return c.json(videoNotFound(scope.userId), 404);
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
	const scope = parseDeveloperVideoScope(c.req.queries());
	if (!scope.ok) {
		return c.json(apiErrorBody(scope.code, scope.message, scope.hint), 400);
	}
	const video = await findAppVideoAndRedrive(
		c.get("developerAppId"),
		c.req.param("id"),
		scope.userId,
	);

	if (!video) {
		return c.json(videoNotFound(scope.userId), 404);
	}

	return c.json({ data: serializeDeveloperVideoStatus(video) });
});

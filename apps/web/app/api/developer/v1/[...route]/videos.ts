import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import { DEVELOPER_VIDEO_RESOLUTION_TIERS } from "@cap/database/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { start } from "workflow/api";
import { z } from "zod";
import { apiErrorBody } from "@/lib/api-errors";
import {
	developerVideoIdForIdempotencyKey,
	invalidIdempotencyKey,
	readIdempotencyKey,
} from "@/lib/developer-ids";
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
import { developerVideosCaptionLinks } from "@/lib/developer-video-captions";
import { markDeveloperVideoDeleted } from "@/lib/developer-video-delete";
import { redriveDeveloperVideoProcessing } from "@/lib/developer-video-start";
import { developerVideoRedrive } from "@/lib/developer-video-state";
import {
	createInfraVideoImport,
	developerVideoImportView,
	newImportVideoId,
} from "@/lib/infra-video-import";
import { IMPORT_URL_MAX_LENGTH } from "@/lib/infra-video-import-limits";
import { developerZValidator } from "@/utils/zod-validator";
import { importDeveloperVideoWorkflow } from "@/workflows/import-developer-video";
import { withDeveloperSecretAuth } from "../../../utils";

type DeveloperVideoRow = typeof developerVideos.$inferSelect;

async function withCaptions(appId: string, videos: DeveloperVideoRow[]) {
	const served = videos.map(serializeDeveloperVideo);
	const links = await developerVideosCaptionLinks(
		appId,
		served.filter((video) => !video.takenDown),
	);
	return served.map((video) => ({
		...video,
		captions: links.get(video.id) ?? [],
	}));
}

async function withImport<T extends { id: string } | undefined>(video: T) {
	if (!video) return video;
	const imported = await developerVideoImportView(video.id);
	return imported ? { ...video, import: imported } : video;
}

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
		developerKeyId: string;
		developerKeyType: "secret";
	};
}>().use(withDeveloperSecretAuth);

app.post(
	"/",
	developerZValidator(
		"json",
		z.strictObject({
			url: z.string().min(1).max(IMPORT_URL_MAX_LENGTH),
			name: z.string().max(255).optional(),
			userId: z.string().max(255).optional(),
			maxResolutionTier: z.enum(DEVELOPER_VIDEO_RESOLUTION_TIERS).optional(),
			metadata: z
				.record(z.string(), z.unknown())
				.optional()
				.refine(
					(val) => val === undefined || JSON.stringify(val).length <= 8192,
					{ message: "Metadata must be under 8KB" },
				),
		}),
	),
	async (c) => {
		const idempotency = readIdempotencyKey(c.req.header("idempotency-key"));
		if (!idempotency.ok) return c.json(invalidIdempotencyKey(), 400);
		const appId = c.get("developerAppId");
		const body = c.req.valid("json");
		const result = await createInfraVideoImport(
			{
				...body,
				appId,
				keyId: c.get("developerKeyId"),
				idempotencyKey: idempotency.key,
				videoId: idempotency.key
					? developerVideoIdForIdempotencyKey(appId, idempotency.key)
					: newImportVideoId(),
			},
			{
				startImport: async (videoId) => {
					await start(importDeveloperVideoWorkflow, [{ videoId }]);
				},
			},
		);
		if (result.status !== 202) {
			return c.json(result.body, result.status, result.headers);
		}
		const video = await findAppVideo(appId, result.videoId, undefined);
		if (!video) return c.json(videoNotFound(undefined), 404);
		const [data] = await withCaptions(appId, [video]);
		return c.json({ data: await withImport(data) }, 200);
	},
);

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
		data: await withCaptions(appId, videos.slice(0, limit)),
		pagination: { limit, offset, hasMore: videos.length > limit },
	});
});

app.get("/:id", async (c) => {
	const scope = parseDeveloperVideoScope(c.req.queries());
	if (!scope.ok) {
		return c.json(apiErrorBody(scope.code, scope.message, scope.hint), 400);
	}
	const appId = c.get("developerAppId");
	const video = await findAppVideoAndRedrive(
		appId,
		c.req.param("id"),
		scope.userId,
	);

	if (!video) {
		return c.json(videoNotFound(scope.userId), 404);
	}

	const [data] = await withCaptions(appId, [video]);
	return c.json({ data: await withImport(data) });
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
		await markDeveloperVideoDeleted({ appId, videoId });
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

	return c.json({
		data: await withImport(serializeDeveloperVideoStatus(video)),
	});
});

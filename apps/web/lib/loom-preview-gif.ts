import "server-only";

import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Option } from "effect";

export const LOOM_PREVIEW_RETRY_MS = 10 * 60 * 1000;
const PREVIEW_URL_EXPIRES_SECONDS = 15 * 60;

export function isLoomPreviewDue(
	metadata: Record<string, unknown> | null | undefined,
	now = Date.now(),
) {
	const preview = metadata?.loomPreviewGif as
		| { status?: string; startedAt?: string }
		| undefined;
	if (preview?.status === "pending") return true;
	if (preview?.status !== "started") return false;
	const startedAt = Date.parse(preview.startedAt ?? "");
	return !Number.isFinite(startedAt) || now - startedAt > LOOM_PREVIEW_RETRY_MS;
}

function getAffectedRows(result: unknown) {
	const header = Array.isArray(result) ? result[0] : result;
	return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

export async function startLoomPreviewGif({
	video,
	getVideoUrl,
	getPreviewPutUrl,
	now = new Date(),
}: {
	video: Video.Video;
	getVideoUrl: (key: string, expiresIn: number) => Promise<string>;
	getPreviewPutUrl: (key: string, expiresIn: number) => Promise<string>;
	now?: Date;
}) {
	const env = serverEnv();
	const duration = Option.getOrUndefined(video.duration);
	if (
		!env.LOOM_IMPORTER_URL ||
		!env.MEDIA_SERVER_WEBHOOK_SECRET ||
		!duration ||
		duration <= 0
	)
		return "unavailable" as const;
	const startedAt = now.toISOString();
	const retryBefore = new Date(
		now.getTime() - LOOM_PREVIEW_RETRY_MS,
	).toISOString();
	const claim = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(${videos.metadata}, '$.loomPreviewGif', JSON_OBJECT('status', 'started', 'startedAt', ${startedAt}))`,
		})
		.where(
			and(
				eq(videos.id, video.id),
				sql`(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomPreviewGif.status')) = 'pending' OR (JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomPreviewGif.status')) = 'started' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomPreviewGif.startedAt')), '') < ${retryBefore}))`,
			),
		);
	if (getAffectedRows(claim) !== 1) return "already-started" as const;

	const prefix = `${video.ownerId}/${video.id}`;
	const response = await fetch(`${env.LOOM_IMPORTER_URL}/video/preview-gif`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-media-server-secret": env.MEDIA_SERVER_WEBHOOK_SECRET,
		},
		body: JSON.stringify({
			videoUrl: await getVideoUrl(
				`${prefix}/result.mp4`,
				PREVIEW_URL_EXPIRES_SECONDS,
			),
			previewGifPresignedUrl: await getPreviewPutUrl(
				`${prefix}/preview/animated-preview.gif`,
				PREVIEW_URL_EXPIRES_SECONDS,
			),
			duration,
		}),
		signal: AbortSignal.timeout(150_000),
	});
	await response.body?.cancel();
	if (!response.ok) return "failed" as const;
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(${videos.metadata}, '$.loomPreviewGif.status', 'complete')`,
		})
		.where(
			and(
				eq(videos.id, video.id),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomPreviewGif.startedAt')) = ${startedAt}`,
			),
		);
	return "complete" as const;
}

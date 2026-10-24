import "server-only";

import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { runPromise } from "@/lib/server";

export const LOOM_PREVIEW_RETRY_MS = 10 * 60 * 1000;
const PREVIEW_WAIT_MS = 45_000;
const PREVIEW_POLL_MS = 2_000;

type PreviewBucket = Effect.Effect.Success<
	ReturnType<Storage["getAccessForVideo"]>
>[0];
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
	if (response.status === 503) {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(${videos.metadata}, '$.loomPreviewGif', JSON_OBJECT('status', 'pending'))`,
			})
			.where(
				and(
					eq(videos.id, video.id),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomPreviewGif.startedAt')) = ${startedAt}`,
				),
			);
		return "busy" as const;
	}
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

function isLoomPreviewRendering(
	metadata: Record<string, unknown> | null | undefined,
	now = Date.now(),
) {
	const preview = metadata?.loomPreviewGif as
		| { status?: string; startedAt?: string }
		| undefined;
	const startedAt = Date.parse(preview?.startedAt ?? "");
	return (
		preview?.status === "started" &&
		Number.isFinite(startedAt) &&
		now - startedAt <= LOOM_PREVIEW_RETRY_MS
	);
}

export function ensureLoomPreviewGif(
	video: Video.Video,
	bucket: PreviewBucket,
	previewKey: string,
) {
	return Effect.promise(async () => {
		const metadata = Option.getOrNull(video.metadata);
		if (isLoomPreviewDue(metadata)) {
			const result = await startLoomPreviewGif({
				video,
				getVideoUrl: (key, expiresIn) =>
					runPromise(bucket.getInternalSignedObjectUrl(key, { expiresIn })),
				getPreviewPutUrl: (key, expiresIn) =>
					runPromise(
						bucket.getInternalPresignedPutUrl(
							key,
							{
								ContentType: "image/gif",
								CacheControl: "public, max-age=31536000, immutable",
							},
							{ expiresIn },
						),
					),
			}).catch((error) => {
				console.warn("[loom-preview-gif] Preview GIF failed", error);
				return "failed" as const;
			});
			if (result === "complete") return true;
			if (result !== "already-started") return false;
		} else if (!isLoomPreviewRendering(metadata)) {
			return false;
		}
		const deadline = Date.now() + PREVIEW_WAIT_MS;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, PREVIEW_POLL_MS));
			const exists = await runPromise(
				bucket.headObject(previewKey).pipe(
					Effect.as(true),
					Effect.catchAll(() => Effect.succeed(false)),
				),
			);
			if (exists) return true;
		}
		return false;
	});
}

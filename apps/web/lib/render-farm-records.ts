import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { upsertRenderFarmExport } from "@/lib/render-farm-status";

type RenderFarmSave = NonNullable<VideoMetadata["renderFarmSave"]>;
type RenderFarmExport = NonNullable<
	VideoMetadata["renderFarmExports"]
>["items"][number];

function affectedRows(result: unknown) {
	const header = Array.isArray(result) ? result[0] : result;
	return typeof header === "object" &&
		header !== null &&
		"affectedRows" in header &&
		typeof header.affectedRows === "number"
		? header.affectedRows
		: 0;
}

export async function recordRenderFarmSave(
	videoId: Video.VideoId,
	save: RenderFarmSave,
) {
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.renderFarmSave', CAST(${JSON.stringify(save)} AS JSON))`,
		})
		.where(eq(videos.id, videoId));
}

/**
 * Marks a finished recording as rendering before its job exists, so the
 * share page opened at stop already waits for the render. Never replaces a
 * save the owner started.
 */
export async function recordPendingRecordingRender(
	videoId: Video.VideoId,
	save: RenderFarmSave,
) {
	const result = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.renderFarmSave', CAST(${JSON.stringify(save)} AS JSON))`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave') IS NULL`,
			),
		);
	return affectedRows(result) === 1;
}

export async function attachRenderFarmJob(
	videoId: Video.VideoId,
	exportId: string,
	jobId: string,
) {
	const result = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(${videos.metadata}, '$.renderFarmSave.jobId', ${jobId})`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave.exportId')) = ${exportId}`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave.status')) = 'rendering'`,
			),
		);
	return affectedRows(result) === 1;
}

export async function failRenderFarmSave(
	videoId: Video.VideoId,
	match: { jobId: string } | { exportId: string },
	error: string,
) {
	const [field, value] =
		"jobId" in match ? ["jobId", match.jobId] : ["exportId", match.exportId];
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(${videos.metadata}, '$.renderFarmSave.status', 'error', '$.renderFarmSave.error', ${error.slice(0, 500)})`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, ${`$.renderFarmSave.${field}`})) = ${value}`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave.status')) = 'rendering'`,
			),
		);
}

/**
 * Forgets a render started when a recording finished that did not make it,
 * leaving the uploaded recording as the share video with nothing to report.
 */
export async function clearRecordingRender(
	videoId: Video.VideoId,
	match: { jobId: string } | { exportId: string },
) {
	const [field, value] =
		"jobId" in match ? ["jobId", match.jobId] : ["exportId", match.exportId];
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_REMOVE(${videos.metadata}, '$.renderFarmSave')`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, ${`$.renderFarmSave.${field}`})) = ${value}`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave.status')) = 'rendering'`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave.trigger')) = 'recording'`,
			),
		);
}

/**
 * Applies `change` to the video's export list under a row lock, so a
 * callback and a status poll finishing the same export cannot interleave.
 */
export async function changeRenderFarmExports(
	videoId: Video.VideoId,
	change: (items: RenderFarmExport[]) => RenderFarmExport[] | null | undefined,
) {
	return db().transaction(async (tx) => {
		const [row] = await tx
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId))
			.for("update");
		if (!row) return null;
		const items = row.metadata?.renderFarmExports?.items ?? [];
		const next = change(items);
		if (!next) return items;
		const exportsValue = JSON.stringify({ version: 1, items: next });
		await tx
			.update(videos)
			.set({
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.renderFarmExports', CAST(${exportsValue} AS JSON))`,
			})
			.where(eq(videos.id, videoId));
		return next;
	});
}

export function recordRenderFarmExport(
	videoId: Video.VideoId,
	item: RenderFarmExport,
) {
	return changeRenderFarmExports(videoId, (items) =>
		upsertRenderFarmExport(items, item),
	);
}

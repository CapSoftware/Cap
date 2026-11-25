import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { videoMetadataObject } from "@/lib/editor-metadata-sql";

type RenderFarmSave = NonNullable<VideoMetadata["renderFarmSave"]>;
type BrowserSave = NonNullable<VideoMetadata["webEditorBrowserSave"]>;

function affectedRows(result: unknown) {
	const header = Array.isArray(result) ? result[0] : result;
	return typeof header === "object" &&
		header !== null &&
		"affectedRows" in header &&
		typeof header.affectedRows === "number"
		? header.affectedRows
		: 0;
}

// Replaces only the save the request saw when it started, so of two Saves
// racing from different tabs the first to record its render keeps it and the
// other's render is never published.
export async function recordRenderFarmSave(
	videoId: Video.VideoId,
	seenExportId: string | null,
	save: RenderFarmSave,
) {
	const result = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_REMOVE(JSON_SET(${videoMetadataObject()}, '$.renderFarmSave', CAST(${JSON.stringify(save)} AS JSON)), '$.webEditorBrowserSave')`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				seenExportId === null
					? sql`JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave.exportId') IS NULL`
					: sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave.exportId')) = ${seenExportId}`,
			),
		);
	return affectedRows(result) === 1;
}

export async function recordPendingRecordingRender(
	videoId: Video.VideoId,
	save: RenderFarmSave,
) {
	const result = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(${videoMetadataObject()}, '$.renderFarmSave', CAST(${JSON.stringify(save)} AS JSON))`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave') IS NULL`,
				sql`JSON_EXTRACT(${videos.metadata}, '$.webEditorBrowserSave') IS NULL`,
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

export async function withdrawRenderFarmSave(
	videoId: Video.VideoId,
	exportId?: string,
) {
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_REMOVE(${videos.metadata}, '$.renderFarmSave')`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave.status')) IN ('rendering', 'error')`,
				...(exportId === undefined
					? []
					: [
							sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave.exportId')) = ${exportId}`,
						]),
			),
		);
}

export async function recordBrowserSave(
	videoId: Video.VideoId,
	save: BrowserSave,
) {
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(${videoMetadataObject()}, '$.webEditorBrowserSave', CAST(${JSON.stringify(save)} AS JSON))`,
		})
		.where(eq(videos.id, videoId));
	await withdrawRenderFarmSave(videoId);
}

export async function updateBrowserSave(
	videoId: Video.VideoId,
	saveId: string,
	change:
		| { progress: number }
		| { status: "published" }
		| { status: "error"; error: string },
	now = new Date(),
) {
	const at = now.toISOString();
	const patch =
		"progress" in change
			? sql`JSON_SET(${videos.metadata}, '$.webEditorBrowserSave.progress', ${change.progress}, '$.webEditorBrowserSave.updatedAt', ${at})`
			: change.status === "published"
				? sql`JSON_SET(${videos.metadata}, '$.webEditorBrowserSave.status', 'published', '$.webEditorBrowserSave.progress', 1, '$.webEditorBrowserSave.updatedAt', ${at}, '$.webEditorBrowserSave.publishedAt', ${at})`
				: sql`JSON_SET(${videos.metadata}, '$.webEditorBrowserSave.status', 'error', '$.webEditorBrowserSave.error', ${change.error.slice(0, 500)}, '$.webEditorBrowserSave.updatedAt', ${at})`;
	const result = await db()
		.update(videos)
		.set({ metadata: patch })
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.webEditorBrowserSave.saveId')) = ${saveId}`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.webEditorBrowserSave.status')) = 'rendering'`,
			),
		);
	return affectedRows(result) === 1;
}

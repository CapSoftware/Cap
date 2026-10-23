import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { User, Video } from "@cap/web-domain";
import { and, eq, or, sql } from "drizzle-orm";

export async function recordLoomMediaDispatch({
	videoId,
	userId,
	runId,
	attemptId,
	state,
	jobId,
}: {
	videoId: string;
	userId: string;
	runId: string;
	attemptId: string;
	state: "accepted" | "rejected" | "uncertain";
	jobId?: string;
}) {
	const receipt = {
		runId,
		dispatch: "accepted",
		mediaDispatch: { attemptId, videoId, state, jobId: jobId ?? null },
	};
	const result = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.loomImportRun', JSON_MERGE_PATCH(COALESCE(JSON_EXTRACT(${videos.metadata}, '$.loomImportRun'), JSON_OBJECT()), JSON_EXTRACT(${JSON.stringify(receipt)}, '$')))`,
		})
		.where(
			and(
				eq(videos.id, Video.VideoId.make(videoId)),
				eq(videos.ownerId, User.UserId.make(userId)),
				or(
					sql`JSON_EXTRACT(${videos.metadata}, '$.loomImportRun') IS NULL`,
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomImportRun.runId')) = ${runId}`,
				),
			),
		);
	const affectedRows = Array.isArray(result)
		? (result[0] as { affectedRows?: number } | undefined)?.affectedRows
		: (result as { affectedRows?: number }).affectedRows;
	if (affectedRows !== 1)
		throw new Error("Loom media dispatch ownership changed");
}

export async function isLoomMediaJobFailed(jobId: string, videoId: string) {
	const env = serverEnv();
	if (!env.MEDIA_SERVER_URL || !env.MEDIA_SERVER_WEBHOOK_SECRET) return false;
	try {
		const response = await fetch(
			`${env.MEDIA_SERVER_URL}/video/process/${encodeURIComponent(jobId)}/status`,
			{
				headers: { "x-media-server-secret": env.MEDIA_SERVER_WEBHOOK_SECRET },
				signal: AbortSignal.timeout(15_000),
				redirect: "error",
			},
		);
		if (!response.ok) return false;
		const progress: unknown = await response.json();
		return (
			typeof progress === "object" &&
			progress !== null &&
			"jobId" in progress &&
			progress.jobId === jobId &&
			"videoId" in progress &&
			progress.videoId === videoId &&
			"phase" in progress &&
			progress.phase === "error"
		);
	} catch {
		return false;
	}
}

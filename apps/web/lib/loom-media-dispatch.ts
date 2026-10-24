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
	worker,
}: {
	videoId: string;
	userId: string;
	runId: string;
	attemptId: string;
	state: "accepted" | "rejected" | "uncertain";
	jobId?: string;
	worker?: "importer" | "media";
}) {
	const receipt = {
		runId,
		dispatch: "accepted",
		mediaDispatch: {
			attemptId,
			videoId,
			state,
			jobId: jobId ?? null,
			worker: worker ?? null,
		},
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

export async function isLoomMediaJobFailed(
	jobId: string,
	videoId: string,
	workerUrl?: string,
) {
	const env = serverEnv();
	const workerUrls = workerUrl
		? [workerUrl]
		: [env.MEDIA_SERVER_URL, env.LOOM_IMPORTER_URL].filter(
				(url): url is string => Boolean(url),
			);
	for (const url of workerUrls)
		if (await isJobFailedOnWorker(url, jobId, videoId)) return true;
	return false;
}

async function isJobFailedOnWorker(
	workerUrl: string,
	jobId: string,
	videoId: string,
) {
	const env = serverEnv();
	if (!env.MEDIA_SERVER_WEBHOOK_SECRET) return false;
	try {
		const response = await fetch(
			`${workerUrl}/video/process/${encodeURIComponent(jobId)}/status`,
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

export type LoomImporterJobState =
	| "running"
	| "finished"
	| "missing"
	| "unknown";

type ImporterJob = { jobId?: unknown; videoId?: unknown; phase?: unknown };

function importerHeaders() {
	const secret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
	return secret ? { "x-media-server-secret": secret } : undefined;
}

export async function getLoomImporterJobState({
	jobId,
	videoId,
}: {
	jobId?: string | null;
	videoId: string;
}): Promise<LoomImporterJobState> {
	const importerUrl = serverEnv().LOOM_IMPORTER_URL;
	const headers = importerHeaders();
	if (!importerUrl || !headers) return "unknown";
	try {
		if (jobId) {
			const response = await fetch(
				`${importerUrl}/video/process/${encodeURIComponent(jobId)}/status`,
				{ headers, signal: AbortSignal.timeout(15_000), redirect: "error" },
			);
			if (response.status === 404) {
				await response.body?.cancel();
				return "missing";
			}
			if (!response.ok) {
				await response.body?.cancel();
				return "unknown";
			}
			const job = (await response.json()) as ImporterJob;
			if (job.jobId !== jobId || job.videoId !== videoId) return "unknown";
			return job.phase === "complete" ||
				job.phase === "error" ||
				job.phase === "cancelled"
				? "finished"
				: "running";
		}
		const response = await fetch(`${importerUrl}/video/status`, {
			headers,
			signal: AbortSignal.timeout(15_000),
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			return "unknown";
		}
		const status = (await response.json()) as { jobs?: ImporterJob[] };
		if (!Array.isArray(status.jobs)) return "unknown";
		return status.jobs.some((job) => job.videoId === videoId)
			? "running"
			: "missing";
	} catch {
		return "unknown";
	}
}

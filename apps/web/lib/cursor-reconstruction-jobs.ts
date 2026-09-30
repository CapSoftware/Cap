import { randomBytes } from "node:crypto";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import {
	CURSOR_RECONSTRUCTION_TIMEOUT_MS,
	type CursorReconstruction,
	cursorReconstructionPrefix,
	cursorReconstructionReference,
} from "@/lib/cursor-reconstruction";
import {
	type RenderFarmConfig,
	renderFarmCallbackUrl,
	renderFarmFetch,
} from "@/lib/render-farm";

function affectedRows(result: unknown) {
	const header = Array.isArray(result) ? result[0] : result;
	return typeof header === "object" &&
		header !== null &&
		"affectedRows" in header &&
		typeof header.affectedRows === "number"
		? header.affectedRows
		: 0;
}

const runMatches = (runId: string) =>
	sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.cursorReconstruction.runId')) = ${runId}`;
const jobMatches = (jobId: string) =>
	sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.cursorReconstruction.jobId')) = ${jobId}`;
const processing = sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.cursorReconstruction.status')) = 'processing'`;
const abandonedBefore = (cutoff: string) =>
	sql`(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.cursorReconstruction.status')), '') <> 'processing' OR JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.cursorReconstruction.startedAt')) < ${cutoff})`;

export type CursorJobSummary = {
	id: string;
	status: "queued" | "running" | "ready" | "error";
	progress: number;
	error?: string;
	display: string;
	inputEvents: string;
	bytes?: { display: number; inputEvents: number };
};

export function parseCursorJobSummary(body: unknown): CursorJobSummary | null {
	if (typeof body !== "object" || body === null) return null;
	const record = body as Record<string, unknown>;
	const bytes = record.bytes as Record<string, unknown> | undefined;
	if (
		typeof record.id !== "string" ||
		!["queued", "running", "ready", "error"].includes(String(record.status)) ||
		typeof record.display !== "string" ||
		typeof record.inputEvents !== "string"
	) {
		return null;
	}
	return {
		id: record.id,
		status: record.status as CursorJobSummary["status"],
		progress:
			typeof record.progress === "number" && Number.isFinite(record.progress)
				? record.progress
				: 0,
		...(typeof record.error === "string"
			? { error: record.error.slice(0, 500) }
			: {}),
		display: record.display,
		inputEvents: record.inputEvents,
		...(bytes &&
		Number.isSafeInteger(bytes.display) &&
		Number.isSafeInteger(bytes.inputEvents)
			? {
					bytes: {
						display: Number(bytes.display),
						inputEvents: Number(bytes.inputEvents),
					},
				}
			: {}),
	};
}

/**
 * Records a new run and hands it to the render farm. Enabling is the owner's
 * request, so the replacement turns on by itself once the run is ready.
 * Returns null when another run is already processing.
 */
export async function startCursorReconstruction(
	video: { id: Video.VideoId; ownerId: string; metadata: VideoMetadata | null },
	config: RenderFarmConfig,
	origin: string,
) {
	const sourceKey = video.metadata?.editorSources?.display.key;
	if (!sourceKey) throw new Error("The recording has no display source");
	const runId = randomBytes(8).toString("hex");
	const run: CursorReconstruction = {
		version: 1,
		runId,
		jobId: "",
		status: "processing",
		enabled: true,
		sourceKey,
		startedAt: new Date().toISOString(),
		progress: 0,
	};
	const recorded = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.cursorReconstruction', CAST(${JSON.stringify(run)} AS JSON))`,
		})
		.where(
			and(
				eq(videos.id, video.id),
				abandonedBefore(
					new Date(Date.now() - CURSOR_RECONSTRUCTION_TIMEOUT_MS).toISOString(),
				),
			),
		);
	if (affectedRows(recorded) !== 1) return null;
	try {
		const response = await renderFarmFetch(config, "/cursor-jobs", {
			method: "POST",
			body: JSON.stringify({
				sourceRoot: `${video.ownerId}/${video.id}/`,
				source: sourceKey,
				outputPrefix: cursorReconstructionPrefix(
					video.ownerId,
					video.id,
					runId,
				),
				callbackUrl: renderFarmCallbackUrl(
					origin,
					process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
				),
				reference: cursorReconstructionReference(video.id),
			}),
		});
		const summary = parseCursorJobSummary(
			response.ok ? await response.json() : null,
		);
		if (!summary) {
			throw new Error(`Render farm rejected the job (${response.status})`);
		}
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(${videos.metadata}, '$.cursorReconstruction.jobId', ${summary.id})`,
			})
			.where(and(eq(videos.id, video.id), runMatches(runId), processing));
		return run;
	} catch (error) {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(${videos.metadata}, '$.cursorReconstruction.status', 'error', '$.cursorReconstruction.error', 'Could not start processing')`,
			})
			.where(and(eq(videos.id, video.id), runMatches(runId), processing));
		throw error;
	}
}

/** Applies a finished or failed farm job to the run that started it. */
export async function settleCursorReconstruction(
	videoId: Video.VideoId,
	summary: CursorJobSummary,
) {
	if (summary.status === "ready") {
		if (!summary.bytes) return false;
		const result = await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(${videos.metadata}, '$.cursorReconstruction.status', 'ready', '$.cursorReconstruction.progress', 1, '$.cursorReconstruction.completedAt', ${new Date().toISOString()}, '$.cursorReconstruction.display', CAST(${JSON.stringify({ key: summary.display, size: summary.bytes.display })} AS JSON), '$.cursorReconstruction.inputEvents', CAST(${JSON.stringify({ key: summary.inputEvents, size: summary.bytes.inputEvents })} AS JSON))`,
			})
			.where(and(eq(videos.id, videoId), jobMatches(summary.id), processing));
		return affectedRows(result) === 1;
	}
	if (summary.status === "error") {
		const result = await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(${videos.metadata}, '$.cursorReconstruction.status', 'error', '$.cursorReconstruction.error', ${(summary.error ?? "Processing failed").slice(0, 500)})`,
			})
			.where(and(eq(videos.id, videoId), jobMatches(summary.id), processing));
		return affectedRows(result) === 1;
	}
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(${videos.metadata}, '$.cursorReconstruction.progress', ${Math.min(0.99, Math.max(0, summary.progress))})`,
		})
		.where(and(eq(videos.id, videoId), jobMatches(summary.id), processing));
	return false;
}

/**
 * Polls the farm for a run still processing, so progress shows and a lost
 * callback cannot leave it processing forever.
 */
export async function refreshCursorReconstruction(
	video: { id: Video.VideoId; metadata: VideoMetadata | null },
	config: RenderFarmConfig,
) {
	const run = video.metadata?.cursorReconstruction;
	if (run?.status !== "processing") return;
	if (
		Date.now() - Date.parse(run.startedAt) >
		CURSOR_RECONSTRUCTION_TIMEOUT_MS
	) {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(${videos.metadata}, '$.cursorReconstruction.status', 'error', '$.cursorReconstruction.error', 'Processing timed out')`,
			})
			.where(and(eq(videos.id, video.id), runMatches(run.runId), processing));
		return;
	}
	if (!run.jobId) return;
	const response = await renderFarmFetch(
		config,
		`/cursor-jobs/${encodeURIComponent(run.jobId)}`,
	);
	if (response.status === 404) {
		await settleCursorReconstruction(video.id, {
			id: run.jobId,
			status: "error",
			progress: 0,
			error: "Processing was interrupted",
			display: "",
			inputEvents: "",
		});
		return;
	}
	const summary = parseCursorJobSummary(
		response.ok ? await response.json() : null,
	);
	if (summary && summary.id === run.jobId) {
		await settleCursorReconstruction(video.id, summary);
	}
}

export async function setCursorReconstructionEnabled(
	videoId: Video.VideoId,
	enabled: boolean,
) {
	const result = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(${videos.metadata}, '$.cursorReconstruction.enabled', CAST(${enabled ? "true" : "false"} AS JSON))`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_EXTRACT(${videos.metadata}, '$.cursorReconstruction') IS NOT NULL`,
			),
		);
	return affectedRows(result) === 1;
}

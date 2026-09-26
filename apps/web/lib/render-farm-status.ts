import type { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";

type DbVideo = typeof videos.$inferSelect;
type RenderFarmSave = NonNullable<VideoMetadata["renderFarmSave"]>;

export type RenderedOutput = {
	width: number;
	height: number;
	fps: number;
	durationSeconds: number;
	bytes: number;
};

export type RenderSaveStatus = {
	state: "idle" | "rendering" | "ready" | "error";
	exportId: string | null;
	progress: number;
	playable: boolean;
	hlsUrl: string | null;
	error: string | null;
};

export const IDLE_RENDER_SAVE: RenderSaveStatus = {
	state: "idle",
	exportId: null,
	progress: 0,
	playable: false,
	hlsUrl: null,
	error: null,
};

// A restarted coordinator reloads unfinished jobs from its journal shortly
// after it starts answering, and renders finish within minutes; a job it
// still does not know after this long is lost.
const UNKNOWN_JOB_GRACE_MS = 15 * 60_000;

/** Whether a save whose job the farm does not know should keep waiting. */
export function awaitingUnknownRenderJob(
	save: Pick<RenderFarmSave, "startedAt">,
	now: number,
) {
	const started = Date.parse(save.startedAt);
	return Number.isFinite(started) && now - started < UNKNOWN_JOB_GRACE_MS;
}

// A render started when a recording finishes waits for an editor worker to
// prepare the recording before its farm job exists.
const PENDING_JOB_GRACE_MS = 30 * 60_000;

/** Whether a recording render still being prepared should keep waiting. */
export function awaitingPendingRenderJob(
	save: Pick<RenderFarmSave, "startedAt">,
	now: number,
) {
	const started = Date.parse(save.startedAt);
	return Number.isFinite(started) && now - started < PENDING_JOB_GRACE_MS;
}

export function validRenderedOutput(output: RenderedOutput) {
	return (
		Number.isSafeInteger(output.width) &&
		output.width > 0 &&
		Number.isSafeInteger(output.height) &&
		output.height > 0 &&
		Number.isFinite(output.fps) &&
		output.fps > 0 &&
		Number.isFinite(output.durationSeconds) &&
		output.durationSeconds > 0 &&
		Number.isSafeInteger(output.bytes) &&
		output.bytes > 0
	);
}

/** The row changes that publish a finished render, or null if it is stale. */
export function publishedRenderFarmUpdate(
	video: Pick<DbVideo, "source" | "metadata">,
	jobId: string,
	output: RenderedOutput,
	now: Date,
) {
	const save = video.metadata?.renderFarmSave;
	if (
		!save ||
		save.jobId !== jobId ||
		save.status !== "rendering" ||
		(video.source.type !== "webMP4" && video.source.type !== "desktopMP4") ||
		!validRenderedOutput(output)
	) {
		return null;
	}
	const metadata: VideoMetadata = { ...(video.metadata ?? {}) };
	// A render of the untouched recording keeps its timing, so the transcript
	// and AI output made from the upload still line up.
	const edited = save.trigger !== "recording";
	if (edited) {
		delete metadata.desktopRecordingUpload;
		delete metadata.summary;
		delete metadata.chapters;
		delete metadata.aiGenerationStatus;
		Reflect.deleteProperty(metadata, "editProcessing");
		Reflect.deleteProperty(metadata, "completedVideoEdit");
	}
	metadata.renderFarmSave = {
		...save,
		status: "published",
		publishedAt: now.toISOString(),
	};
	return {
		source: { type: video.source.type, outputKey: save.outputKey },
		metadata,
		...(edited ? { transcriptionStatus: null } : {}),
		duration: output.durationSeconds,
		width: output.width,
		height: output.height,
		fps: Math.round(output.fps),
	};
}

export function renderSaveStatusFromMetadata(
	save: RenderFarmSave | undefined,
): RenderSaveStatus | null {
	if (!save) return IDLE_RENDER_SAVE;
	if (save.status === "published") {
		return {
			...IDLE_RENDER_SAVE,
			state: "ready",
			exportId: save.exportId,
			progress: 1,
		};
	}
	if (save.status === "error") {
		return {
			...IDLE_RENDER_SAVE,
			state: "error",
			exportId: save.exportId,
			error: save.error ?? "Export failed",
		};
	}
	return null;
}

type RenderFarmExport = NonNullable<
	VideoMetadata["renderFarmExports"]
>["items"][number];

const MAX_KEPT_EXPORTS = 10;

/** The export list with `item` added or replaced, newest first, bounded. */
export function upsertRenderFarmExport(
	items: readonly RenderFarmExport[] | undefined,
	item: RenderFarmExport,
) {
	return [
		item,
		...(items ?? []).filter((existing) => existing.exportId !== item.exportId),
	].slice(0, MAX_KEPT_EXPORTS);
}

/** How long a background export stays downloadable after it finishes. */
export const RENDER_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type RenderExportView = {
	exportId: string;
	state: "rendering" | "ready" | "error" | "expired";
	fileName: string;
	resolution: [number, number];
	fps: number;
	bytes: number | null;
	startedAt: string;
	completedAt: string | null;
	error: string | null;
};

export function renderExportView(
	item: RenderFarmExport,
	now: number,
): RenderExportView {
	const completedAt = item.completedAt ? Date.parse(item.completedAt) : NaN;
	const expired =
		item.status === "ready" &&
		(!Number.isFinite(completedAt) || now - completedAt > RENDER_EXPORT_TTL_MS);
	return {
		exportId: item.exportId,
		state: expired ? "expired" : item.status,
		fileName: item.fileName,
		resolution: item.resolution,
		fps: item.fps,
		bytes: item.bytes ?? null,
		startedAt: item.startedAt,
		completedAt: item.completedAt ?? null,
		error: item.status === "error" ? (item.error ?? "Export failed") : null,
	};
}

/** The export a download link names, or the newest when it names none. */
export function pickRenderExport(
	exports: readonly RenderExportView[],
	exportId: string | null | undefined,
) {
	return exportId
		? (exports.find((item) => item.exportId === exportId) ?? null)
		: (exports[0] ?? null);
}

/** A download name from the video title: safe on every OS, always .mp4. */
export function renderExportFileName(title: string | null | undefined) {
	const base = (title ?? "")
		.replace(/\.mp4$/i, "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^A-Za-z0-9 ._-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s-]+|[.\s-]+$/g, "")
		.slice(0, 120)
		.trim();
	return `${base || "Cap Export"}.mp4`;
}

/** Content-Disposition for a download, with an RFC 5987 UTF-8 fallback. */
export function attachmentDisposition(fileName: string) {
	const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

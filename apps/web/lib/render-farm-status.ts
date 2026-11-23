import type { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import {
	knownEditorSourceDuration,
	validEditorSourceDuration,
} from "@/lib/editor-source-duration";

type DbVideo = typeof videos.$inferSelect;
type RenderFarmSave = NonNullable<VideoMetadata["renderFarmSave"]>;
type BrowserSave = NonNullable<VideoMetadata["webEditorBrowserSave"]>;

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
	inBrowser?: boolean;
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

export function awaitingUnknownRenderJob(
	save: Pick<RenderFarmSave, "startedAt">,
	now: number,
) {
	const started = Date.parse(save.startedAt);
	return Number.isFinite(started) && now - started < UNKNOWN_JOB_GRACE_MS;
}

// A render started when a recording finishes waits for the rest of its
// sources to upload before its farm job exists.
const PENDING_JOB_GRACE_MS = 30 * 60_000;

export function awaitingPendingRenderJob(
	save: Pick<RenderFarmSave, "startedAt">,
	now: number,
) {
	const started = Date.parse(save.startedAt);
	return Number.isFinite(started) && now - started < PENDING_JOB_GRACE_MS;
}

// A browser Save reports progress every few seconds while its tab renders;
// one that stopped reporting for this long was closed or crashed.
export const BROWSER_SAVE_STALE_MS = 2 * 60_000;

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

export function publishedRenderFarmUpdate(
	video: Pick<DbVideo, "source" | "metadata" | "duration"> & {
		id: string;
		ownerId: string;
	},
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
	delete metadata.webEditorBrowserSave;
	const sourceDuration =
		knownEditorSourceDuration(video) ??
		(!edited && validEditorSourceDuration(output.durationSeconds)
			? output.durationSeconds
			: null);
	if (sourceDuration !== null) metadata.editorSourceDuration = sourceDuration;
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

export function renderFarmSaveIsCurrent(metadata: VideoMetadata | null) {
	const save = metadata?.renderFarmSave;
	return (
		savedProjectIsPublished(metadata) ||
		(save?.status === "rendering" &&
			save.projectSavedAt !== undefined &&
			save.projectSavedAt === (metadata?.webEditorProject?.savedAt ?? null))
	);
}

// A browser Save takes over a farm render of the same project that is still
// running: the editor only starts one when the farm stalled or failed.
export function savedProjectIsPublished(metadata: VideoMetadata | null) {
	const savedAt = metadata?.webEditorProject?.savedAt ?? null;
	const save = metadata?.renderFarmSave;
	const browser = metadata?.webEditorBrowserSave;
	return (
		(save?.status === "published" &&
			save.projectSavedAt !== undefined &&
			save.projectSavedAt === savedAt) ||
		(browser?.status === "published" && browser.projectSavedAt === savedAt)
	);
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

export function browserSaveStatus(
	save: BrowserSave,
	now: number,
): RenderSaveStatus {
	const base = { ...IDLE_RENDER_SAVE, exportId: save.saveId };
	if (save.status === "published") {
		return { ...base, state: "ready", progress: 1 };
	}
	const updatedAt = Date.parse(save.updatedAt);
	if (
		save.status === "error" ||
		!Number.isFinite(updatedAt) ||
		now - updatedAt > BROWSER_SAVE_STALE_MS
	) {
		return {
			...base,
			state: "error",
			error: save.error ?? "This save couldn't finish. Try again.",
		};
	}
	return {
		...base,
		state: "rendering",
		progress: Math.min(0.99, Math.max(0, save.progress)),
		inBrowser: true,
	};
}

export function latestSaveIsBrowser(metadata: VideoMetadata | null) {
	const browser = metadata?.webEditorBrowserSave;
	if (!browser) return false;
	const farm = metadata?.renderFarmSave;
	if (!farm) return true;
	return Date.parse(browser.startedAt) >= Date.parse(farm.startedAt);
}

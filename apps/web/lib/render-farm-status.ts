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
	delete metadata.desktopRecordingUpload;
	delete metadata.summary;
	delete metadata.chapters;
	delete metadata.aiGenerationStatus;
	Reflect.deleteProperty(metadata, "editProcessing");
	Reflect.deleteProperty(metadata, "completedVideoEdit");
	metadata.renderFarmSave = {
		...save,
		status: "published",
		publishedAt: now.toISOString(),
	};
	return {
		source: { type: video.source.type, outputKey: save.outputKey },
		metadata,
		transcriptionStatus: null,
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

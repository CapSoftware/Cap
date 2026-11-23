import { db } from "@cap/database";
import { videoProcessingJobs, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { retireDesktopRecordingJobForOutputReplacement } from "@/lib/desktop-recording-jobs";
import { invalidateReuploadedVideo } from "@/lib/desktop-reupload";
import {
	queueVideoTranscription,
	shouldQueueTranscriptionAfterMultipartComplete,
} from "@/lib/queue-video-transcription";
import { enqueuePreviewAssetsRefresh } from "@/lib/refresh-preview-assets";
import {
	mapRenderFarmJob,
	renderFarmConfig,
	renderFarmFetch,
} from "@/lib/render-farm";
import {
	clearRecordingRender,
	failRenderFarmSave,
} from "@/lib/render-farm-records";
import {
	awaitingPendingRenderJob,
	awaitingUnknownRenderJob,
	browserSaveStatus,
	IDLE_RENDER_SAVE,
	latestSaveIsBrowser,
	publishedRenderFarmUpdate,
	type RenderedOutput,
	type RenderSaveStatus,
	renderSaveStatusFromMetadata,
	validRenderedOutput,
} from "@/lib/render-farm-status";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

type DbVideo = typeof videos.$inferSelect;
type RenderFarmSave = NonNullable<VideoMetadata["renderFarmSave"]>;

// Must stay idempotent: the callback and a status poll may both get here.
export async function finalizeRenderFarmSave(
	videoId: Video.VideoId,
	jobId: string,
	output: RenderedOutput,
) {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	const save = video?.metadata?.renderFarmSave;
	if (!video || !save || save.jobId !== jobId) return "stale" as const;
	if (save.status === "published") return "published" as const;
	if (save.status !== "rendering" || !validRenderedOutput(output)) {
		return "stale" as const;
	}
	const head = await runPromise(
		Effect.gen(function* () {
			const [storage] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
				{ resolvePublishedOutput: false },
			);
			return yield* storage.headObject(save.outputKey);
		}),
	);
	if (head.ContentLength !== output.bytes) {
		throw new Error("Rendered export could not be verified");
	}
	const published = await db().transaction(async (tx) => {
		await tx
			.select({ videoId: videoProcessingJobs.videoId })
			.from(videoProcessingJobs)
			.where(eq(videoProcessingJobs.videoId, videoId))
			.for("update");
		const [locked] = await tx
			.select()
			.from(videos)
			.where(eq(videos.id, videoId))
			.for("update");
		const update =
			locked && publishedRenderFarmUpdate(locked, jobId, output, new Date());
		if (!locked || !update) return false;
		await retireDesktopRecordingJobForOutputReplacement(tx, {
			videoId,
			userId: locked.ownerId,
		});
		await tx.update(videos).set(update).where(eq(videos.id, videoId));
		return true;
	});
	if (!published) return "stale" as const;
	await invalidateReuploadedVideo(decodeStorageVideo(video)).catch((error) =>
		console.warn("Could not refresh derived recording assets", error),
	);
	await enqueuePreviewAssetsRefresh(videoId);
	if (
		save.trigger !== "recording" &&
		shouldQueueTranscriptionAfterMultipartComplete(video.source.type, false)
	) {
		await queueVideoTranscription(videoId).catch((error) =>
			console.warn("Could not queue transcription after save", error),
		);
	}
	return "published" as const;
}

export async function abandonRenderFarmSave(
	videoId: Video.VideoId,
	save: Pick<RenderFarmSave, "exportId" | "trigger">,
	match: { jobId: string } | { exportId: string },
	error: string,
): Promise<RenderSaveStatus> {
	if (save.trigger === "recording") {
		await clearRecordingRender(videoId, match);
		return IDLE_RENDER_SAVE;
	}
	await failRenderFarmSave(videoId, match, error);
	return {
		...IDLE_RENDER_SAVE,
		state: "error",
		exportId: save.exportId,
		error,
	};
}

async function currentRenderFarmSave(
	videoId: Video.VideoId,
	previous: NonNullable<VideoMetadata["renderFarmSave"]>,
): Promise<RenderSaveStatus> {
	const [current] = await db()
		.select({ id: videos.id, fps: videos.fps, metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId));
	const save = current?.metadata?.renderFarmSave;
	if (!current || !save) return IDLE_RENDER_SAVE;
	if (save.jobId === previous.jobId && save.status === previous.status) {
		return { ...IDLE_RENDER_SAVE, state: "rendering", exportId: save.exportId };
	}
	return refreshRenderFarmSave(current);
}

export async function refreshRenderFarmSave(
	video: Pick<DbVideo, "id" | "fps" | "metadata">,
): Promise<RenderSaveStatus> {
	const save = video.metadata?.renderFarmSave;
	const settled = renderSaveStatusFromMetadata(save);
	if (settled || !save) return settled ?? IDLE_RENDER_SAVE;
	const rendering: RenderSaveStatus = {
		...IDLE_RENDER_SAVE,
		state: "rendering",
		exportId: save.exportId,
	};
	const videoId = video.id as Video.VideoId;
	if (!save.jobId) {
		if (awaitingPendingRenderJob(save, Date.now())) return rendering;
		return abandonRenderFarmSave(
			videoId,
			save,
			{ exportId: save.exportId },
			"The recording could not be rendered",
		);
	}
	const job = await fetchRenderFarmJob(save.jobId, video.fps ?? 30);
	if (!job) return rendering;
	if (job.state === "ready" && job.output) {
		const finalized = await finalizeRenderFarmSave(videoId, save.jobId, {
			width: job.output.width,
			height: job.output.height,
			fps: job.output.fps,
			durationSeconds: job.output.frames / job.output.fps,
			bytes: job.output.bytes,
		});
		if (finalized === "stale") return currentRenderFarmSave(videoId, save);
		return {
			...IDLE_RENDER_SAVE,
			state: "ready",
			exportId: save.exportId,
			progress: 1,
		};
	}
	if (job.state === "gone" && awaitingUnknownRenderJob(save, Date.now())) {
		return rendering;
	}
	if (job.state === "error" || job.state === "gone") {
		return abandonRenderFarmSave(
			videoId,
			save,
			{ jobId: save.jobId },
			job.error ?? "The export is no longer available",
		);
	}
	return {
		...rendering,
		progress: job.progress,
		playable: job.playable,
		hlsUrl: job.playable ? job.hlsUrl : null,
	};
}

async function fetchRenderFarmJob(jobId: string, fps: number) {
	const config = renderFarmConfig();
	if (!config) return null;
	const response = await renderFarmFetch(
		config,
		`/jobs/${encodeURIComponent(jobId)}`,
	).catch(() => null);
	if (!response) return null;
	const body: unknown = await response.json().catch(() => null);
	try {
		return mapRenderFarmJob({ status: response.status, body }, fps);
	} catch {
		return null;
	}
}

export async function refreshSaveStatus(
	video: Pick<DbVideo, "id" | "fps" | "metadata">,
): Promise<RenderSaveStatus> {
	const browser = video.metadata?.webEditorBrowserSave;
	if (browser && latestSaveIsBrowser(video.metadata ?? null)) {
		return browserSaveStatus(browser, Date.now());
	}
	return refreshRenderFarmSave(video);
}

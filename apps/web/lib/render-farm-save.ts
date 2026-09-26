import { db } from "@cap/database";
import { videoProcessingJobs, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { retireDesktopRecordingJobForOutputReplacement } from "@/lib/desktop-recording-jobs";
import { invalidateReuploadedVideo } from "@/lib/desktop-reupload";
import {
	queueVideoTranscription,
	shouldQueueTranscriptionAfterMultipartComplete,
} from "@/lib/queue-video-transcription";
import {
	mapRenderFarmJob,
	renderFarmConfig,
	renderFarmFetch,
} from "@/lib/render-farm";
import {
	awaitingUnknownRenderJob,
	IDLE_RENDER_SAVE,
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

export async function failRenderFarmSave(
	videoId: Video.VideoId,
	jobId: string,
	error: string,
) {
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(${videos.metadata}, '$.renderFarmSave.status', 'error', '$.renderFarmSave.error', ${error.slice(0, 500)})`,
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave.jobId')) = ${jobId}`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.renderFarmSave.status')) = 'rendering'`,
			),
		);
}

/**
 * Switches the video to a finished render, like a reupload to the same link.
 * Idempotent: the callback and a status poll may both get here.
 */
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
	if (
		shouldQueueTranscriptionAfterMultipartComplete(video.source.type, false)
	) {
		await queueVideoTranscription(videoId).catch((error) =>
			console.warn("Could not queue transcription after save", error),
		);
	}
	return "published" as const;
}

/**
 * Current state of a video's render-farm save. Polls the farm for renders in
 * flight and publishes or fails them here when the callback has not landed.
 */
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
	const config = renderFarmConfig();
	if (!config) return rendering;
	const response = await renderFarmFetch(
		config,
		`/jobs/${encodeURIComponent(save.jobId)}`,
	).catch(() => null);
	if (!response) return rendering;
	const body: unknown = await response.json().catch(() => null);
	let job: ReturnType<typeof mapRenderFarmJob>;
	try {
		job = mapRenderFarmJob({ status: response.status, body }, video.fps ?? 30);
	} catch {
		return rendering;
	}
	const videoId = video.id as Video.VideoId;
	if (job.state === "ready" && job.output) {
		await finalizeRenderFarmSave(videoId, save.jobId, {
			width: job.output.width,
			height: job.output.height,
			fps: job.output.fps,
			durationSeconds: job.output.frames / job.output.fps,
			bytes: job.output.bytes,
		});
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
		const error = job.error ?? "The export is no longer available";
		await failRenderFarmSave(videoId, save.jobId, error);
		return {
			...IDLE_RENDER_SAVE,
			state: "error",
			exportId: save.exportId,
			error,
		};
	}
	return {
		...rendering,
		progress: job.progress,
		playable: job.playable,
		hlsUrl: job.playable ? job.hlsUrl : null,
	};
}

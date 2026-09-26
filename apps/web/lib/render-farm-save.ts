import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { ExportReady } from "@cap/database/emails/export-ready";
import { users, videoProcessingJobs, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
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
import {
	mapRenderFarmJob,
	renderFarmConfig,
	renderFarmFetch,
} from "@/lib/render-farm";
import {
	changeRenderFarmExports,
	clearRecordingRender,
	failRenderFarmSave,
} from "@/lib/render-farm-records";
import {
	awaitingPendingRenderJob,
	awaitingUnknownRenderJob,
	IDLE_RENDER_SAVE,
	publishedRenderFarmUpdate,
	type RenderExportView,
	type RenderedOutput,
	type RenderSaveStatus,
	renderExportView,
	renderSaveStatusFromMetadata,
	upsertRenderFarmExport,
	validRenderedOutput,
} from "@/lib/render-farm-status";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

type DbVideo = typeof videos.$inferSelect;
type RenderFarmSave = NonNullable<VideoMetadata["renderFarmSave"]>;
type RenderFarmExport = NonNullable<
	VideoMetadata["renderFarmExports"]
>["items"][number];

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
		save.trigger !== "recording" &&
		shouldQueueTranscriptionAfterMultipartComplete(video.source.type, false)
	) {
		await queueVideoTranscription(videoId).catch((error) =>
			console.warn("Could not queue transcription after save", error),
		);
	}
	return "published" as const;
}

/**
 * Records that a save's render failed. A render started when the recording
 * finished is forgotten instead, since the upload it would have replaced is
 * still the share video.
 */
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
	const videoId = video.id as Video.VideoId;
	if (!save.jobId) {
		if (awaitingPendingRenderJob(save, Date.now())) return rendering;
		return abandonRenderFarmSave(
			videoId,
			save,
			{ exportId: save.exportId },
			"The recording could not be prepared for rendering",
		);
	}
	const job = await fetchRenderFarmJob(save.jobId, video.fps ?? 30);
	if (!job) return rendering;
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

export function failRenderFarmExport(
	videoId: Video.VideoId,
	jobId: string,
	error: string,
) {
	return changeRenderFarmExports(videoId, (items) => {
		const item = items.find((candidate) => candidate.jobId === jobId);
		if (item?.status !== "rendering") return null;
		return upsertRenderFarmExport(items, {
			...item,
			status: "error",
			error: error.slice(0, 500),
			completedAt: new Date().toISOString(),
		});
	});
}

/**
 * Marks a background export downloadable and emails its owner once.
 * Idempotent: the callback and a status poll may both get here, and a
 * retried callback re-sends with the same idempotency key.
 */
export async function finalizeRenderFarmExport(
	videoId: Video.VideoId,
	jobId: string,
	output: RenderedOutput,
) {
	const [record] = await db()
		.select({ video: videos, email: users.email })
		.from(videos)
		.innerJoin(users, eq(videos.ownerId, users.id))
		.where(eq(videos.id, videoId));
	const current = record?.video.metadata?.renderFarmExports?.items.find(
		(item) => item.jobId === jobId,
	);
	if (!record || !current || current.status === "error") {
		return "stale" as const;
	}
	let ready: RenderFarmExport | undefined = current;
	if (current.status === "rendering") {
		if (!validRenderedOutput(output)) return "stale" as const;
		const head = await runPromise(
			Effect.gen(function* () {
				const [storage] = yield* Storage.getAccessForVideo(
					decodeStorageVideo(record.video),
					{ resolvePublishedOutput: false },
				);
				return yield* storage.headObject(current.outputKey);
			}),
		);
		if (head.ContentLength !== output.bytes) {
			throw new Error("Rendered export could not be verified");
		}
		const items = await changeRenderFarmExports(videoId, (items) => {
			const item = items.find((candidate) => candidate.jobId === jobId);
			if (item?.status !== "rendering") return null;
			return upsertRenderFarmExport(items, {
				...item,
				status: "ready",
				bytes: output.bytes,
				completedAt: new Date().toISOString(),
			});
		});
		ready = items?.find((item) => item.jobId === jobId);
	}
	if (ready?.status !== "ready") return "stale" as const;
	if (ready.emailedAt) return "ready" as const;
	const exportId = ready.exportId;
	await sendEmail({
		email: record.email,
		subject: `Your export of "${record.video.name}" is ready`,
		react: ExportReady({
			email: record.email,
			url: `${serverEnv().WEB_URL}/s/${videoId}/download?export=${encodeURIComponent(exportId)}`,
			videoName: record.video.name,
		}),
		idempotencyKey: `render-export-ready-${exportId}`,
	});
	await changeRenderFarmExports(videoId, (items) => {
		const item = items.find((candidate) => candidate.exportId === exportId);
		if (!item || item.emailedAt) return null;
		return upsertRenderFarmExport(items, {
			...item,
			emailedAt: new Date().toISOString(),
		});
	});
	return "ready" as const;
}

/**
 * The video's background exports, polling the farm for any still rendering
 * so a missed callback cannot leave one pending forever.
 */
export async function refreshRenderFarmExports(
	video: Pick<DbVideo, "id" | "fps" | "metadata">,
): Promise<RenderExportView[]> {
	const videoId = video.id as Video.VideoId;
	const items = video.metadata?.renderFarmExports?.items ?? [];
	const refreshed = await Promise.all(
		items.map(async (item): Promise<RenderFarmExport> => {
			if (item.status !== "rendering") return item;
			const job = await fetchRenderFarmJob(item.jobId, item.fps);
			if (!job) return item;
			if (job.state === "ready" && job.output) {
				const result = await finalizeRenderFarmExport(videoId, item.jobId, {
					width: job.output.width,
					height: job.output.height,
					fps: job.output.fps,
					durationSeconds: job.output.frames / job.output.fps,
					bytes: job.output.bytes,
				}).catch((error) => {
					console.warn("Could not finish background export", error);
					return "stale" as const;
				});
				return result === "ready"
					? {
							...item,
							status: "ready",
							bytes: job.output.bytes,
							completedAt: new Date().toISOString(),
						}
					: item;
			}
			if (job.state === "gone" && awaitingUnknownRenderJob(item, Date.now())) {
				return item;
			}
			if (job.state === "error" || job.state === "gone") {
				const error = job.error ?? "The export is no longer available";
				await failRenderFarmExport(videoId, item.jobId, error);
				return { ...item, status: "error", error };
			}
			return item;
		}),
	);
	const now = Date.now();
	return refreshed.map((item) => renderExportView(item, now));
}

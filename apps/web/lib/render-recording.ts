import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { after } from "next/server";
import { start } from "workflow/api";
import { renderRecordingWorkflow } from "@/workflows/render-recording";
import { renderFarmConfig, renderFarmKeys } from "./render-farm";
import {
	clearRecordingRender,
	recordPendingRecordingRender,
} from "./render-farm-records";
import {
	prewarmRenderFarmSource,
	renderFarmPrepareSupport,
} from "./render-farm-start";
import { recordingRenderEligible } from "./render-recording-eligibility";
import {
	type RecordingRenderPayload,
	recordingSourcesState,
	startRecordingRenderDirectly,
} from "./render-recording-start";
import { runPromise } from "./server";
import { decodeStorageVideo } from "./video-storage";
import { isWebStudioEnabledForEmail } from "./web-studio-rollout";

// The last source normally lands within a second of the one that finished
// the upload; waiting that long here beats handing over to the workflow.
const INLINE_SOURCE_WAIT_MS = 5_000;
const INLINE_SOURCE_POLL_MS = 250;

// Started from the warm request that finished the upload: the workflow's
// queue hops and cold starts cost 1 to 6 s before the farm heard of the job.
async function startRecordingRenderInline(
	payload: RecordingRenderPayload,
): Promise<"done" | "unsupported" | "handover"> {
	const deadline = Date.now() + INLINE_SOURCE_WAIT_MS;
	for (;;) {
		const sources = await recordingSourcesState(payload);
		if (sources === "superseded") return "done";
		if (sources === "ready") break;
		if (Date.now() >= deadline) return "handover";
		await new Promise((resolve) => setTimeout(resolve, INLINE_SOURCE_POLL_MS));
	}
	const started = await startRecordingRenderDirectly(payload);
	return started === "unsupported" ? "unsupported" : "done";
}

export async function startRecordingRender(
	videoId: Video.VideoId,
	origin: string,
) {
	if (!renderFarmConfig()?.callbackSecret) return false;
	if (!(await renderFarmPrepareSupport())) return false;
	const [row] = await db()
		.select({ video: videos, owner: users, uploadPhase: videoUploads.phase })
		.from(videos)
		.innerJoin(users, eq(videos.ownerId, users.id))
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(eq(videos.id, videoId));
	if (
		!row ||
		!isWebStudioEnabledForEmail(row.owner.email) ||
		!recordingRenderEligible({
			isScreenshot: row.video.isScreenshot,
			sourceType: row.video.source.type,
			duration: row.video.duration,
			metadata: row.video.metadata,
			ownerIsPro: userIsPro(row.owner),
		})
	) {
		return false;
	}
	const exportId = randomUUID();
	const target = renderFarmKeys(row.video.ownerId, videoId, exportId);
	const recorded = await recordPendingRecordingRender(videoId, {
		version: 1,
		exportId,
		jobId: "",
		status: "rendering",
		trigger: "recording",
		projectSavedAt: null,
		startedAt: new Date().toISOString(),
		outputKey: target.outputKey,
		hlsPrefix: target.hlsPrefix,
	});
	if (!recorded) return false;
	const payload = { videoId, ownerId: row.video.ownerId, exportId, origin };
	after(async () => {
		const started = await startRecordingRenderInline(payload).catch((error) => {
			console.error(
				"[renderRecording] Render did not start inline, handing over",
				videoId,
				error,
			);
			return "handover" as const;
		});
		if (started === "done") return;
		if (started === "unsupported") {
			await clearRecordingRender(videoId, { exportId }).catch(() => undefined);
			return;
		}
		await start(renderRecordingWorkflow, [payload]).catch(async (error) => {
			console.error("[renderRecording] Render did not start", videoId, error);
			await clearRecordingRender(videoId, { exportId }).catch(() => undefined);
		});
	});
	return true;
}

const STUDIO_VIDEO_SOURCE = /\/(raw|camera)-upload\.(mp4|webm)$/;

export async function onStudioSourcesComplete(input: {
	videoId: Video.VideoId;
	key: string;
	origin: string;
}) {
	try {
		if (!renderFarmConfig()) return;
		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, input.videoId));
		if (!video || !input.key.startsWith(`${video.ownerId}/${video.id}/`))
			return;
		if (STUDIO_VIDEO_SOURCE.test(input.key)) {
			const storageVideo = decodeStorageVideo(video);
			after(() =>
				runPromise(
					prewarmRenderFarmSource(storageVideo, input.key).pipe(
						Effect.timeout("30 seconds"),
					),
				).catch(() => undefined),
			);
		}
		await startRecordingRender(input.videoId, input.origin);
	} catch (error) {
		console.error("[renderRecording] Source completion failed", error);
	}
}

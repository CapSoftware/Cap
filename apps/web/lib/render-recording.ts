import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { after } from "next/server";
import { start } from "workflow/api";
import { renderFarmConfig, renderFarmKeys } from "./render-farm";
import {
	clearRecordingRender,
	recordPendingRecordingRender,
} from "./render-farm-records";
import { recordingRenderEligible } from "./render-recording-eligibility";
import {
	type RecordingRenderPayload,
	recordingSourcesState,
	startRecordingRenderDirectly,
} from "./render-recording-start";
import { renderRecordingWorkflow } from "./render-recording-workflow";
import { isWebStudioEnabledForEmail } from "./web-studio-rollout";

// The last source normally lands within a second of the one that finished
// the upload; waiting that long here beats handing over to the workflow.
const INLINE_SOURCE_WAIT_MS = 5_000;
const INLINE_SOURCE_POLL_MS = 250;

/**
 * Starts the render from the request that finished the upload, which is
 * warm: the workflow's queue hops and cold starts cost 1 to 6 s before the
 * farm heard of the job. Returns false when the workflow should start it.
 */
async function startRecordingRenderInline(payload: RecordingRenderPayload) {
	const deadline = Date.now() + INLINE_SOURCE_WAIT_MS;
	for (;;) {
		const sources = await recordingSourcesState(payload);
		if (sources === "superseded") return true;
		if (sources === "ready") break;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, INLINE_SOURCE_POLL_MS));
	}
	const started = await startRecordingRenderDirectly(payload);
	return started !== "unsupported";
}

/**
 * Starts rendering a just-finished recording in the background and marks
 * its share page as rendering straight away. Best effort: the original
 * upload stays the share video whenever this does not finish.
 */
export async function startRecordingRender(
	videoId: Video.VideoId,
	origin: string,
) {
	if (!renderFarmConfig()?.callbackSecret) return false;
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
				`[renderRecording] ${videoId} did not start inline, handing over`,
				error,
			);
			return false;
		});
		if (started) return;
		// Waiting on slow sources, an editor worker preparing the recording,
		// and retries are the workflow's.
		await start(renderRecordingWorkflow, [payload]).catch(async (error) => {
			console.error(
				`[renderRecording] Render did not start for ${videoId}`,
				error,
			);
			await clearRecordingRender(videoId, { exportId }).catch(() => undefined);
		});
	});
	return true;
}

import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { renderFarmConfig, renderFarmKeys } from "./render-farm";
import {
	clearRecordingRender,
	recordPendingRecordingRender,
} from "./render-farm-records";
import { recordingRenderEligible } from "./render-recording-eligibility";
import { renderRecordingWorkflow } from "./render-recording-workflow";
import { isWebStudioEnabledForEmail } from "./web-studio-rollout";

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
		startedAt: new Date().toISOString(),
		outputKey: target.outputKey,
		hlsPrefix: target.hlsPrefix,
	});
	if (!recorded) return false;
	try {
		await start(renderRecordingWorkflow, [
			{ videoId, ownerId: row.video.ownerId, exportId, origin },
		]);
		return true;
	} catch (error) {
		await clearRecordingRender(videoId, { exportId }).catch(() => undefined);
		throw error;
	}
}

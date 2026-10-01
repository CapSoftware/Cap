import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import { recordingDefaultStyle } from "@cap/editor-cap-bundle/default-style";
import { userIsPro } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { attachRenderFarmJob } from "./render-farm-records";
import {
	renderFarmPrepareSupport,
	startRenderFarmJobDirect,
} from "./render-farm-start";
import { recordingRenderSourcesReady } from "./render-recording-eligibility";
import { runWorkflowPromise } from "./workflow-runtime";

// Shared by the render-recording workflow's steps and the upload request that
// starts a render directly. Kept out of the workflow module, whose exports
// the workflow bundle keeps along with everything they import.

export type RecordingRenderPayload = {
	videoId: string;
	ownerId: string;
	exportId: string;
	origin: string;
};

export async function loadRenderVideo(payload: RecordingRenderPayload) {
	const [row] = await db()
		.select({ video: videos, owner: users, uploadPhase: videoUploads.phase })
		.from(videos)
		.innerJoin(users, eq(videos.ownerId, users.id))
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(eq(videos.id, payload.videoId as Video.VideoId));
	const save = row?.video.metadata?.renderFarmSave;
	if (
		!row ||
		row.video.ownerId !== payload.ownerId ||
		save?.exportId !== payload.exportId ||
		save.status !== "rendering"
	) {
		return null;
	}
	// The recording renders as it was recorded, in the owner's style. Edits
	// made in the editor meanwhile reach the share link when they're saved.
	const { webEditorProject: _edits, ...metadata } = row.video.metadata ?? {};
	return {
		video: {
			...row.video,
			metadata,
			captionsEnabled: userIsPro(row.owner),
			defaultStyle: recordingDefaultStyle(
				row.owner.preferences?.editorDefaultStyle,
				row.video.metadata?.recorderCamera,
			),
		},
		uploadPhase: row.uploadPhase,
	};
}

/** Whether the render can start: its sources are in, or it was replaced. */
export async function recordingSourcesState(payload: RecordingRenderPayload) {
	const loaded = await loadRenderVideo(payload);
	if (!loaded) return "superseded" as const;
	return recordingRenderSourcesReady(
		loaded.video.metadata,
		loaded.video.duration,
		loaded.uploadPhase,
	)
		? ("ready" as const)
		: ("waiting" as const);
}

/** The farm-prepared start, run by the workflow or by the finished upload. */
export async function startRecordingRenderDirectly(
	payload: RecordingRenderPayload,
) {
	const support = await renderFarmPrepareSupport();
	if (!support) return "unsupported" as const;
	const loaded = await loadRenderVideo(payload);
	if (!loaded) return "superseded" as const;
	const started = await startRenderFarmJobDirect({
		video: loaded.video,
		origin: payload.origin,
		kind: "recording",
		exportId: payload.exportId,
		support,
	}).pipe(runWorkflowPromise);
	if ("unsupported" in started) {
		console.info(
			`[renderRecording] ${payload.videoId} needs an editor worker: ${started.unsupported}`,
		);
		return "unsupported" as const;
	}
	await attachRenderFarmJob(loaded.video.id, payload.exportId, started.jobId);
	console.info(`[renderRecording] ${payload.videoId} prepared by the farm`);
	return "started" as const;
}

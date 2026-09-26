import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import { parseDefaultStyle } from "@cap/editor-cap-bundle/default-style";
import { userIsPro } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError, sleep } from "workflow";
import { requestEditorPreparation } from "./editor-preparation";
import { getSignedEditorSources, requestMediaEditor } from "./editor-session";
import { editorWorkerIdFromSessionId } from "./editor-worker-routing";
import {
	attachRenderFarmJob,
	clearRecordingRender,
} from "./render-farm-records";
import { startRenderFarmJob } from "./render-farm-start";
import { recordingRenderSourcesReady } from "./render-recording-eligibility";
import { runWorkflowPromise } from "./workflow-runtime";

type RecordingRenderPayload = {
	videoId: string;
	ownerId: string;
	exportId: string;
	origin: string;
};

const SOURCE_WAIT_ATTEMPTS = 480;
const CAPACITY_WAIT_ATTEMPTS = 40;
const PREPARATION_POLL_ATTEMPTS = 300;

// The last source usually lands within a second or two of the one that
// started the render, and preparations take seconds: poll quickly at first
// (every poll is a workflow step) and back off for long uploads.
function pollDelay(attempt: number) {
	return attempt < 30 ? "1s" : "5s";
}

async function loadRenderVideo(payload: RecordingRenderPayload) {
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
		save.status !== "rendering" ||
		row.video.metadata?.webEditorProject
	) {
		return null;
	}
	return {
		video: {
			...row.video,
			captionsEnabled: userIsPro(row.owner),
			defaultStyle: parseDefaultStyle(
				row.owner.preferences?.editorDefaultStyle,
			),
		},
		uploadPhase: row.uploadPhase,
	};
}

async function checkRecordingSources(payload: RecordingRenderPayload) {
	"use step";

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

async function requestRecordingPreparation(payload: RecordingRenderPayload) {
	"use step";

	const loaded = await loadRenderVideo(payload);
	if (!loaded) return { superseded: true } as const;
	const sources = await getSignedEditorSources(loaded.video).pipe(
		runWorkflowPromise,
	);
	return await requestEditorPreparation(loaded.video.id, sources).pipe(
		runWorkflowPromise,
	);
}

async function readRecordingPreparation(preparationId: string) {
	"use step";

	const response = await requestMediaEditor(
		`/editor/preparations/${encodeURIComponent(preparationId)}`,
	).pipe(runWorkflowPromise);
	if (!response.ok) throw new Error("Editor preparation status is unavailable");
	const data: unknown = await response.json();
	if (typeof data !== "object" || data === null || !("status" in data)) {
		throw new Error("Editor preparation status is invalid");
	}
	if (
		data.status === "ready" &&
		"sessionId" in data &&
		typeof data.sessionId === "string" &&
		editorWorkerIdFromSessionId(data.sessionId) ===
			editorWorkerIdFromSessionId(preparationId)
	) {
		return { state: "ready", sessionId: data.sessionId } as const;
	}
	if (data.status === "preparing") return { state: "preparing" } as const;
	return { state: "failed" } as const;
}

async function startRecordingRenderJob(
	payload: RecordingRenderPayload,
	sessionId: string,
) {
	"use step";

	const loaded = await loadRenderVideo(payload);
	if (!loaded) return;
	const started = await startRenderFarmJob({
		video: loaded.video,
		sessionPath: `/editor/sessions/${encodeURIComponent(sessionId)}`,
		origin: payload.origin,
		kind: "recording",
		exportId: payload.exportId,
	}).pipe(runWorkflowPromise);
	await attachRenderFarmJob(loaded.video.id, payload.exportId, started.jobId);
}

async function releaseRecordingSession(
	preparationId: string,
	sessionId: string | null,
) {
	"use step";

	await requestMediaEditor(
		sessionId
			? `/editor/sessions/${encodeURIComponent(sessionId)}`
			: `/editor/preparations/${encodeURIComponent(preparationId)}`,
		{ method: "DELETE" },
	)
		.pipe(runWorkflowPromise)
		.catch(() => undefined);
}

async function abandonRecordingRender(payload: RecordingRenderPayload) {
	"use step";

	await clearRecordingRender(payload.videoId as Video.VideoId, {
		exportId: payload.exportId,
	});
}

async function waitForRecordingSources(
	payload: RecordingRenderPayload,
): Promise<boolean> {
	for (let attempt = 0; ; attempt++) {
		const sources = await checkRecordingSources(payload);
		if (sources !== "waiting") return sources === "ready";
		if (attempt >= SOURCE_WAIT_ATTEMPTS) {
			throw new FatalError("The recording did not finish uploading");
		}
		await sleep(pollDelay(attempt));
	}
}

async function prepareRecording(
	payload: RecordingRenderPayload,
): Promise<string | null> {
	for (let attempt = 0; ; attempt++) {
		const prepared = await requestRecordingPreparation(payload);
		if ("superseded" in prepared) return null;
		if ("id" in prepared && prepared.id) return prepared.id;
		if (attempt >= CAPACITY_WAIT_ATTEMPTS) {
			throw new FatalError("Editor workers stayed busy");
		}
		await sleep("30s");
	}
}

async function waitForRecordingSession(preparationId: string): Promise<string> {
	for (let attempt = 0; ; attempt++) {
		const preparation = await readRecordingPreparation(preparationId);
		if (preparation.state === "ready") return preparation.sessionId;
		if (
			preparation.state === "failed" ||
			attempt >= PREPARATION_POLL_ATTEMPTS
		) {
			throw new FatalError("The recording could not be prepared");
		}
		await sleep(pollDelay(attempt));
	}
}

/**
 * Renders a finished recording on the render farm: waits for its sources,
 * prepares it on an editor worker, uploads the render project and starts
 * the job. The farm's callback publishes the result like a Save.
 */
export async function renderRecordingWorkflow(payload: RecordingRenderPayload) {
	"use workflow";

	let preparationId: string | null = null;
	let sessionId: string | null = null;
	try {
		if (!(await waitForRecordingSources(payload))) {
			await abandonRecordingRender(payload);
			return { started: false };
		}
		preparationId = await prepareRecording(payload);
		if (!preparationId) {
			await abandonRecordingRender(payload);
			return { started: false };
		}
		sessionId = await waitForRecordingSession(preparationId);
		await startRecordingRenderJob(payload, sessionId);
		return { started: true };
	} catch (error) {
		console.error(
			`[renderRecording] Render did not start for ${payload.videoId}`,
			error,
		);
		await abandonRecordingRender(payload);
		return { started: false };
	} finally {
		if (preparationId) await releaseRecordingSession(preparationId, sessionId);
	}
}

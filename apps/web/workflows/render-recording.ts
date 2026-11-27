import type { Video } from "@cap/web-domain";
import { FatalError, sleep } from "workflow";
import { clearRecordingRender } from "@/lib/render-farm-records";
import {
	type RecordingRenderPayload,
	recordingSourcesState,
	startRecordingRenderDirectly,
} from "@/lib/render-recording-start";

const SOURCE_WAIT_ATTEMPTS = 480;

// The last source usually lands within a second or two of the one that
// started the render: poll quickly at first (every poll is a workflow step)
// and back off for long uploads.
function pollDelay(attempt: number) {
	return attempt < 30 ? "1s" : "5s";
}

async function checkRecordingSources(payload: RecordingRenderPayload) {
	"use step";

	return await recordingSourcesState(payload);
}

async function startDirectRecordingRender(payload: RecordingRenderPayload) {
	"use step";

	return await startRecordingRenderDirectly(payload);
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

export async function renderRecordingWorkflow(payload: RecordingRenderPayload) {
	"use workflow";

	try {
		if (!(await waitForRecordingSources(payload))) {
			await abandonRecordingRender(payload);
			return { started: false };
		}
		const direct = await startDirectRecordingRender(payload);
		if (direct === "started") return { started: true };
		await abandonRecordingRender(payload);
		return { started: false };
	} catch (error) {
		console.error(
			`[renderRecording] Render did not start for ${payload.videoId}`,
			error,
		);
		await abandonRecordingRender(payload);
		return { started: false };
	}
}

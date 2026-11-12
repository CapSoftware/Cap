import type { DeveloperVideoPart } from "@cap/database/types";
import { FatalError, sleep } from "workflow";
import {
	checkDeveloperVideoPart,
	type DeveloperVideoDispatch,
	type DeveloperVideoPartSnapshot,
	type DeveloperVideoPreparation,
	dispatchDeveloperVideoPart,
	failDeveloperVideoProcessing,
	isDeveloperVideoRefusal,
	prepareDeveloperVideoProcessing,
	readDeveloperVideoParts,
	sweepSupersededDeveloperVideoOutputs,
} from "@/lib/developer-video-processing";
import { DEVELOPER_VIDEO_PARTS } from "@/lib/developer-video-state";

interface ProcessDeveloperVideoPayload {
	videoId: string;
	encodeId: string;
}

const PROCESSING_DEADLINE_MS = 3 * 60 * 60 * 1000;
const RETRY_SECONDS = 20;
const PROBING_POLL_SECONDS = 2;
const MAX_POLL_SECONDS = 20;
const TIMED_OUT =
	"Processing took too long and was stopped. Upload the video again.";
const INTERNAL_FAILURE =
	"Processing failed because of a problem on our side. Upload the video again.";
const UNOPENABLE = "The uploaded file could not be opened. Upload it again.";
// An unclear probe error is tried again after 20, 40, 80, 160 and 320
// seconds, so a storage or media-server fault has about ten minutes to clear
// and a file that never opens costs six probes.
const MAX_UNCLEAR_PROBES = 6;
const MAX_UNCLEAR_WAIT_SECONDS = 320;

type Prepared = DeveloperVideoPreparation | { refused: string };

function prepareWaitSeconds(
	prepared: DeveloperVideoPreparation,
	unclear: number,
): number {
	if (prepared === "probing") return PROBING_POLL_SECONDS;
	if (prepared !== "unclear") return RETRY_SECONDS;
	return Math.min(
		MAX_UNCLEAR_WAIT_SECONDS,
		RETRY_SECONDS * 2 ** Math.max(0, unclear - 1),
	);
}

export async function processDeveloperVideoWorkflow(
	payload: ProcessDeveloperVideoPayload,
): Promise<{ success: boolean }> {
	"use workflow";

	const { videoId, encodeId } = payload;

	try {
		const deadline = Date.now() + PROCESSING_DEADLINE_MS;

		for (let unclear = 0; ; ) {
			const prepared = await prepareVideo(videoId, encodeId);
			if (typeof prepared === "object") {
				await failVideo(videoId, encodeId, prepared.refused);
				return { success: false };
			}
			if (prepared === "stale") return { success: false };
			if (prepared === "ready") break;
			if (prepared === "unclear" && ++unclear >= MAX_UNCLEAR_PROBES) {
				await failVideo(videoId, encodeId, UNOPENABLE);
				return { success: false };
			}
			if (Date.now() >= deadline) {
				await failVideo(videoId, encodeId, TIMED_OUT);
				return { success: false };
			}
			await sleep(`${prepareWaitSeconds(prepared, unclear)}s`);
		}

		for (let poll = 0; ; poll++) {
			const parts = await readParts(videoId, encodeId);
			if (!parts) return { success: false };

			const pending = DEVELOPER_VIDEO_PARTS.filter(
				(part) => parts[part] === "dispatch",
			);
			const silent = DEVELOPER_VIDEO_PARTS.filter(
				(part) => parts[part] === "check",
			);
			const waiting = DEVELOPER_VIDEO_PARTS.some(
				(part) => parts[part] === "wait",
			);
			if (pending.length === 0 && silent.length === 0 && !waiting) break;
			if (Date.now() >= deadline) {
				await failVideo(videoId, encodeId, TIMED_OUT);
				break;
			}

			const [dispatched] = await Promise.all([
				Promise.all(
					pending.map((part) => dispatchPart(videoId, encodeId, part)),
				),
				Promise.all(silent.map((part) => checkPart(videoId, encodeId, part))),
			]);
			const busy = dispatched.includes("busy");
			await sleep(
				`${busy ? RETRY_SECONDS : Math.min(MAX_POLL_SECONDS, 2 + poll * 2)}s`,
			);
		}

		await sweepOutputs(videoId, encodeId);
		return { success: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error("[developer-video] Processing failed", { videoId, message });
		await failVideo(videoId, encodeId, INTERNAL_FAILURE);
		throw new FatalError(message);
	}
}

async function prepareVideo(
	videoId: string,
	encodeId: string,
): Promise<Prepared> {
	"use step";

	// A refusal is an answer, not a failed step: thrown, the step would be run
	// again and the same file probed several more times for the same result.
	try {
		return await prepareDeveloperVideoProcessing(videoId, encodeId);
	} catch (error) {
		if (isDeveloperVideoRefusal(error)) return { refused: error.message };
		throw error;
	}
}

async function readParts(
	videoId: string,
	encodeId: string,
): Promise<DeveloperVideoPartSnapshot | null> {
	"use step";

	return readDeveloperVideoParts(videoId, encodeId);
}

async function dispatchPart(
	videoId: string,
	encodeId: string,
	part: DeveloperVideoPart,
): Promise<DeveloperVideoDispatch> {
	"use step";

	return dispatchDeveloperVideoPart(videoId, encodeId, part);
}

async function checkPart(
	videoId: string,
	encodeId: string,
	part: DeveloperVideoPart,
): Promise<void> {
	"use step";

	// A check that throws is asked again on the next pass. Thrown out of the
	// step it would be retried and then fail a video that may be encoding fine.
	try {
		await checkDeveloperVideoPart(videoId, encodeId, part);
	} catch (error) {
		console.error("[developer-video] Failed to check a quiet encode job", {
			videoId,
			part,
			error,
		});
	}
}

async function failVideo(
	videoId: string,
	encodeId: string,
	reason: string,
): Promise<void> {
	"use step";

	await failDeveloperVideoProcessing(videoId, encodeId, reason);
}

async function sweepOutputs(videoId: string, encodeId: string): Promise<void> {
	"use step";

	try {
		await sweepSupersededDeveloperVideoOutputs(videoId, encodeId);
	} catch (error) {
		console.error("[developer-video] Failed to sweep superseded outputs", {
			videoId,
			error,
		});
	}
}

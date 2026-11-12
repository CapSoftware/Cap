import type { DeveloperVideoPart } from "@cap/database/types";
import { FatalError, sleep } from "workflow";
import {
	type DeveloperVideoDispatch,
	type DeveloperVideoPartSnapshot,
	type DeveloperVideoPreparation,
	dispatchDeveloperVideoPart,
	failDeveloperVideoProcessing,
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
const TIMED_OUT = "Video processing timed out";

export async function processDeveloperVideoWorkflow(
	payload: ProcessDeveloperVideoPayload,
): Promise<{ success: boolean }> {
	"use workflow";

	const { videoId, encodeId } = payload;

	try {
		const deadline = Date.now() + PROCESSING_DEADLINE_MS;

		for (;;) {
			const prepared = await prepareVideo(videoId, encodeId);
			if (prepared === "stale") return { success: false };
			if (prepared === "ready") break;
			if (Date.now() >= deadline) {
				await failVideo(videoId, encodeId, TIMED_OUT);
				return { success: false };
			}
			await sleep(
				`${prepared === "probing" ? PROBING_POLL_SECONDS : RETRY_SECONDS}s`,
			);
		}

		for (let poll = 0; ; poll++) {
			const parts = await readParts(videoId, encodeId);
			if (!parts) return { success: false };

			const pending = DEVELOPER_VIDEO_PARTS.filter(
				(part) => parts[part] === "dispatch",
			);
			const waiting = DEVELOPER_VIDEO_PARTS.some(
				(part) => parts[part] === "wait",
			);
			if (pending.length === 0 && !waiting) break;
			if (Date.now() >= deadline) {
				await failVideo(videoId, encodeId, TIMED_OUT);
				break;
			}

			const dispatched = await Promise.all(
				pending.map((part) => dispatchPart(videoId, encodeId, part)),
			);
			const busy = dispatched.includes("busy");
			await sleep(
				`${busy ? RETRY_SECONDS : Math.min(MAX_POLL_SECONDS, 2 + poll * 2)}s`,
			);
		}

		await sweepOutputs(videoId, encodeId);
		return { success: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await failVideo(videoId, encodeId, message);
		throw new FatalError(message);
	}
}

async function prepareVideo(
	videoId: string,
	encodeId: string,
): Promise<DeveloperVideoPreparation> {
	"use step";

	return prepareDeveloperVideoProcessing(videoId, encodeId);
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

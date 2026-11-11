import type { DeveloperVideoPart } from "@cap/database/types";
import { FatalError, sleep } from "workflow";
import {
	type DeveloperVideoDispatch,
	type DeveloperVideoPartSnapshot,
	dispatchDeveloperVideoPart,
	failDeveloperVideoProcessing,
	prepareDeveloperVideoProcessing,
	readDeveloperVideoParts,
} from "@/lib/developer-video-processing";
import { DEVELOPER_VIDEO_PARTS } from "@/lib/developer-video-state";

interface ProcessDeveloperVideoPayload {
	videoId: string;
}

const PROCESSING_DEADLINE_MS = 3 * 60 * 60 * 1000;
const BUSY_RETRY_SECONDS = 20;
const MAX_POLL_SECONDS = 20;

export async function processDeveloperVideoWorkflow(
	payload: ProcessDeveloperVideoPayload,
): Promise<{ success: boolean }> {
	"use workflow";

	const { videoId } = payload;

	try {
		if (!(await prepareVideo(videoId))) return { success: false };

		const deadline = Date.now() + PROCESSING_DEADLINE_MS;
		for (let poll = 0; ; poll++) {
			const parts = await readParts(videoId);
			if (!parts) return { success: false };

			const pending = DEVELOPER_VIDEO_PARTS.filter(
				(part) => parts[part] === "pending",
			);
			const running = DEVELOPER_VIDEO_PARTS.some(
				(part) => parts[part] === "running",
			);
			if (pending.length === 0 && !running) break;
			if (Date.now() >= deadline) {
				await failVideo(videoId, "Video processing timed out");
				break;
			}

			let busy = false;
			for (const part of pending) {
				if ((await dispatchPart(videoId, part)) === "busy") busy = true;
			}
			await sleep(
				`${busy ? BUSY_RETRY_SECONDS : Math.min(MAX_POLL_SECONDS, 2 + poll * 2)}s`,
			);
		}

		return { success: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await failVideo(videoId, message);
		throw new FatalError(message);
	}
}

async function prepareVideo(videoId: string): Promise<boolean> {
	"use step";

	return prepareDeveloperVideoProcessing(videoId);
}

async function readParts(
	videoId: string,
): Promise<DeveloperVideoPartSnapshot | null> {
	"use step";

	return readDeveloperVideoParts(videoId);
}

async function dispatchPart(
	videoId: string,
	part: DeveloperVideoPart,
): Promise<DeveloperVideoDispatch> {
	"use step";

	return dispatchDeveloperVideoPart(videoId, part);
}

async function failVideo(videoId: string, reason: string): Promise<void> {
	"use step";

	await failDeveloperVideoProcessing(videoId, reason);
}

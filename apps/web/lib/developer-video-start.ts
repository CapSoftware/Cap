import { after } from "next/server";
import { start } from "workflow/api";
import { processDeveloperVideoWorkflow } from "@/workflows/process-developer-video";
import {
	claimDeveloperVideoProcessing,
	type DeveloperVideoClaim,
	dispatchDeveloperVideoPart,
	failDeveloperVideoProcessing,
	isDeveloperVideoRefusal,
	prepareDeveloperVideoProcessing,
	readDeveloperVideoParts,
	releaseDeveloperVideoClaim,
} from "./developer-video-processing";
import { DEVELOPER_VIDEO_PARTS } from "./developer-video-state";

export function claimDeveloperVideoUpload(videoId: string) {
	return claimDeveloperVideoProcessing(videoId, { uploadCompleted: true });
}

export function releaseDeveloperVideoUpload(
	videoId: string,
	claim: DeveloperVideoClaim,
) {
	return releaseDeveloperVideoClaim(videoId, claim);
}

export function startDeveloperVideoProcessing(
	videoId: string,
	claim?: DeveloperVideoClaim,
): Promise<boolean> {
	return claimAndStart(videoId, { uploadCompleted: true }, claim);
}

export function redriveDeveloperVideoProcessing(
	videoId: string,
): Promise<boolean> {
	return claimAndStart(videoId, {});
}

// The workflow reaches the encoder through several queued steps, which costs
// seconds on every video. The same first pass runs here straight away. Every
// transition is taken under the video's row lock, so the workflow finds the
// work already done and is left to watch over it, retry it and time it out.
export async function kickStartDeveloperVideo(
	videoId: string,
	encodeId: string,
): Promise<void> {
	try {
		const prepared = await prepareDeveloperVideoProcessing(videoId, encodeId);
		if (prepared !== "ready") return;
		const parts = await readDeveloperVideoParts(videoId, encodeId);
		if (!parts) return;
		await Promise.allSettled(
			DEVELOPER_VIDEO_PARTS.filter((part) => parts[part] === "dispatch").map(
				(part) => dispatchDeveloperVideoPart(videoId, encodeId, part),
			),
		);
	} catch (error) {
		// A refused upload is failed here, so the customer hears within a second
		// or two. Anything else is left to the workflow, which runs the same
		// steps and records the failure.
		if (isDeveloperVideoRefusal(error)) {
			await failDeveloperVideoProcessing(
				videoId,
				encodeId,
				error.message,
			).catch(() => {});
		}
	}
}

function kickStartAfterResponse(videoId: string, encodeId: string): void {
	const kick = kickStartDeveloperVideo(videoId, encodeId);
	try {
		after(kick);
	} catch {
		// Outside a request scope there is nothing to keep alive.
		void kick;
	}
}

async function claimAndStart(
	videoId: string,
	options: { uploadCompleted?: boolean },
	held?: DeveloperVideoClaim,
): Promise<boolean> {
	try {
		const claimed =
			held ?? (await claimDeveloperVideoProcessing(videoId, options));
		if (!claimed) return false;
		try {
			await start(processDeveloperVideoWorkflow, [
				{ videoId, encodeId: claimed.encodeId },
			]);
		} catch (error) {
			await releaseDeveloperVideoClaim(videoId, claimed);
			throw error;
		}
		kickStartAfterResponse(videoId, claimed.encodeId);
		return true;
	} catch (error) {
		console.error("[developer-video] Failed to start processing", {
			videoId,
			error,
		});
		return false;
	}
}

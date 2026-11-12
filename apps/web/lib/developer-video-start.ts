import { start } from "workflow/api";
import { processDeveloperVideoWorkflow } from "@/workflows/process-developer-video";
import {
	claimDeveloperVideoProcessing,
	type DeveloperVideoClaim,
	releaseDeveloperVideoClaim,
} from "./developer-video-processing";

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
			return true;
		} catch (error) {
			await releaseDeveloperVideoClaim(videoId, claimed);
			throw error;
		}
	} catch (error) {
		console.error("[developer-video] Failed to start processing", {
			videoId,
			error,
		});
		return false;
	}
}

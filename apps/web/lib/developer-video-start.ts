import { start } from "workflow/api";
import { processDeveloperVideoWorkflow } from "@/workflows/process-developer-video";
import {
	claimDeveloperVideoProcessing,
	releaseDeveloperVideoClaim,
} from "./developer-video-processing";

export function startDeveloperVideoProcessing(
	videoId: string,
): Promise<boolean> {
	return claimAndStart(videoId, { uploadCompleted: true });
}

export function redriveDeveloperVideoProcessing(
	videoId: string,
): Promise<boolean> {
	return claimAndStart(videoId, {});
}

async function claimAndStart(
	videoId: string,
	options: { uploadCompleted?: boolean },
): Promise<boolean> {
	try {
		const claimed = await claimDeveloperVideoProcessing(videoId, options);
		if (!claimed) return false;
		try {
			await start(processDeveloperVideoWorkflow, [{ videoId }]);
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

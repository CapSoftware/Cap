import { EffectRuntime, getRpcClient } from "@/lib/rpc";
import type { VideoId } from "./web-recorder-types";

export const sendProgressUpdate = async (
	videoId: VideoId,
	uploaded: number,
	total: number,
) => {
	try {
		const rpc = getRpcClient();
		await EffectRuntime.runPromise(
			rpc.VideoUploadProgressUpdate({
				videoId,
				uploaded,
				total,
				updatedAt: new Date(),
			}),
		);
	} catch (error) {
		console.error("Failed to send progress update:", error);
	}
};

import { EffectRuntime } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";
import type { VideoId } from "./WebRecorderDialog/web-recorder-types";

export const sendProgressUpdate = async (
	videoId: VideoId,
	uploaded: number,
	total: number,
) => {
	try {
		await EffectRuntime.runPromise(
			withRpc((rpc) =>
				rpc.VideoUploadProgressUpdate({
					videoId,
					uploaded,
					total,
					updatedAt: new Date(),
				}),
			),
		);
	} catch (error) {
		console.error("Failed to send progress update:", error);
	}
};

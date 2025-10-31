import { EffectRuntime } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";

export const sendProgressUpdate = async (
	videoId: string,
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

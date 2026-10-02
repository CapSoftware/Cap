import type { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { getOutputPreviewAssetKeys } from "@/lib/published-output";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

export {
	getOutputPreviewAssetKeys,
	getReplacementAwaitingPreviewAssets,
	getReplacementOutputKey,
} from "@/lib/published-output";

export async function findOutputPreviewAssets(
	video: typeof videos.$inferSelect,
	outputKey: string,
) {
	const [bucket] = await runWorkflowPromise(
		Storage.getAccessForVideo(decodeStorageVideo(video)),
	);
	const { thumbnailKey, previewKey } = getOutputPreviewAssetKeys(outputKey);
	const present = await Promise.all([
		runWorkflowPromise(bucket.headObject(thumbnailKey)).catch(() => null),
		runWorkflowPromise(bucket.headObject(previewKey)).catch(() => null),
	]);
	return {
		...(present[0]?.ContentLength ? { thumbnailKey } : {}),
		...(present[1]?.ContentLength ? { previewKey } : {}),
	};
}

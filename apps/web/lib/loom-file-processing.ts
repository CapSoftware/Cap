import {
	LoomImportStartError,
	startLoomImportWorkflow,
} from "@/lib/loom-import-start";
import {
	setVideoProcessingError,
	type startVideoProcessingWorkflow,
	transitionVideoToProcessing,
	type VideoProcessingStartStatus,
} from "@/lib/video-processing";

export const LOOM_FILE_SINGLE_UPLOAD_MAX_BYTES = 5 * 1024 ** 3;

export async function startLoomFileProcessingWorkflow({
	loomVideoId,
	...input
}: Pick<
	Parameters<typeof startVideoProcessingWorkflow>[0],
	| "videoId"
	| "userId"
	| "rawFileKey"
	| "bucketId"
	| "processingMessage"
	| "startFailureMessage"
> & {
	loomVideoId: string;
}): Promise<VideoProcessingStartStatus> {
	if (!/^[a-f0-9]{32}$/i.test(loomVideoId)) {
		throw new Error("The uploaded file has no valid Loom source mapping.");
	}
	const status = await transitionVideoToProcessing({
		videoId: input.videoId,
		rawFileKey: input.rawFileKey,
		processingMessage: input.processingMessage,
	});
	if (status !== "started") return status;

	try {
		await startLoomImportWorkflow({
			videoId: input.videoId,
			userId: input.userId,
			rawFileKey: input.rawFileKey,
			bucketId: input.bucketId,
			loomVideoId,
			reuseExistingRawUpload: true,
			cleanupRawUpload: true,
		});
		return "started";
	} catch (error) {
		if (!(error instanceof LoomImportStartError) || error.canRetry) {
			await setVideoProcessingError(
				input.videoId,
				input.startFailureMessage,
				error,
			);
		}
		throw error;
	}
}

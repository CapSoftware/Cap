import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { RetryableError } from "workflow";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

async function syncVideoStorageNamesStep(videoId: string) {
	"use step";

	try {
		await Storage.syncVideoDisplayNames(Video.VideoId.make(videoId)).pipe(
			runWorkflowPromise,
		);
	} catch (error) {
		console.error("Video storage names could not be synchronized", {
			videoId,
			error,
		});
		throw new RetryableError("Video storage names are not synchronized yet", {
			retryAfter: "1 minute",
		});
	}
}

syncVideoStorageNamesStep.maxRetries = 60;

export async function syncVideoStorageNamesWorkflow(input: {
	videoId: string;
}) {
	"use workflow";

	await syncVideoStorageNamesStep(input.videoId);
}

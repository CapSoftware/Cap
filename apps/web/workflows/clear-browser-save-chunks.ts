import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { sleep } from "workflow";
import { browserSaveChunkPrefix } from "@/lib/browser-save-chunks";
import { recentBrowserSave } from "@/lib/render-farm-status";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

type ClearBrowserSaveChunksInput = { videoId: string; saveId: string };

/// Deletes the video's Save chunks except those of a Save still streaming,
/// and says whether that's the one given.
async function clearChunksStep({
	videoId,
	saveId,
}: ClearBrowserSaveChunksInput) {
	"use step";

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));
	if (!video) return false;
	const save = recentBrowserSave(video.metadata);
	const prefix = browserSaveChunkPrefix(video.ownerId, video.id);
	const streaming = save && !save.finished && save.saveId;
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	let continuationToken: string | undefined;
	do {
		const page = await bucket
			.listObjects({ prefix, continuationToken })
			.pipe(runWorkflowPromise);
		const stale = (page.Contents ?? []).flatMap(({ Key }) =>
			Key && !(streaming && Key.startsWith(`${prefix}${streaming}/`))
				? [{ Key }]
				: [],
		);
		if (stale.length > 0)
			await bucket.deleteObjects(stale).pipe(runWorkflowPromise);
		continuationToken = page.NextContinuationToken;
	} while (continuationToken);
	return streaming === saveId;
}

/**
 * Deletes the chunks a Save streamed while it rendered in the owner's
 * browser, an hour after it stops, whether it published, failed or its tab
 * went away.
 */
export async function clearBrowserSaveChunksWorkflow(
	input: ClearBrowserSaveChunksInput,
) {
	"use workflow";

	do await sleep("1h");
	while (await clearChunksStep(input));
}

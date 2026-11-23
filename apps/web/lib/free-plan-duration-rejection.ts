import { db } from "@cap/database";
import { type videos, videoUploads } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { eq } from "drizzle-orm";
import {
	freePlanDurationExceededError,
	freePlanDurationExceededMessage,
	getFreePlanDurationLimit,
} from "@/lib/free-plan-duration";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

// A free plan upload that measures over the limit is never published. The
// upload is failed first, with the message multipart completion returns, so
// processing stops; then its output, previews and raw upload are removed. The
// raw key is only cleared once they are gone, so a retried callback still
// finds a source stored under any supported extension. Nothing is removed
// once the upload is gone, so a late callback cannot delete a newer, published
// result, or once the plan no longer limits the video, so the caller can treat
// the refusal as an ordinary, retryable failure.
export async function rejectFreePlanOverLimitVideo(
	video: typeof videos.$inferSelect,
	upload: { rawFileKey: string | null } | undefined,
): Promise<"rejected" | "no-upload" | "not-limited"> {
	if (!upload) return "no-upload";
	if ((await getFreePlanDurationLimit(video)) === null) return "not-limited";
	const rawFileKey = upload.rawFileKey;
	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage: freePlanDurationExceededMessage,
			processingError: freePlanDurationExceededError,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, video.id));
	const prefix = `${video.ownerId}/${video.id}/`;
	const keys = new Set([
		`${prefix}result.mp4`,
		`${prefix}screenshot/screen-capture.jpg`,
		`${prefix}preview/animated-preview.gif`,
		`${prefix}raw-upload.mp4`,
		`${prefix}raw-upload.webm`,
	]);
	if (rawFileKey?.startsWith(prefix)) keys.add(rawFileKey);
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);
	await bucket
		.deleteObjects([...keys].map((Key) => ({ Key })))
		.pipe(runPromise);
	await db()
		.update(videoUploads)
		.set({ rawFileKey: null })
		.where(eq(videoUploads.videoId, video.id));
	return "rejected";
}

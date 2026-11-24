import { db } from "@cap/database";
import { type videos, videoUploads } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import {
	freePlanDurationExceededError,
	freePlanDurationExceededMessage,
	getFreePlanDurationLimit,
} from "@/lib/free-plan-duration";
import { recordFreePlanMeasure } from "@/lib/free-plan-measure";
import {
	measureFreePlanObject,
	runAfterResponse,
} from "@/lib/free-plan-measure-probe";

// A free plan upload that measures over the limit is never published: the
// upload is failed with the multipart completion message, so processing stops,
// and the video is held. Nothing is deleted, so upgrading lifts the hold and
// processing can be retried from the kept source. Nothing changes once the
// upload is gone, so a late callback cannot touch a newer result, or once the
// plan no longer limits the video, so the caller can treat the refusal as an
// ordinary, retryable failure.
export async function rejectFreePlanOverLimitVideo(
	video: typeof videos.$inferSelect,
	upload: { rawFileKey: string | null } | undefined,
	measuredSeconds?: number | null,
): Promise<"rejected" | "no-upload" | "not-limited"> {
	if (!upload) return "no-upload";
	if ((await getFreePlanDurationLimit(video)) === null) return "not-limited";
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
	const sourceKey = upload.rawFileKey?.startsWith(
		`${video.ownerId}/${video.id}/`,
	)
		? upload.rawFileKey
		: null;
	if (sourceKey && measuredSeconds != null)
		await recordFreePlanMeasure(video.id, sourceKey, measuredSeconds);
	else if (sourceKey)
		runAfterResponse(() =>
			measureFreePlanObject(video.id, sourceKey, { anyAge: true, fresh: true }),
		);
	return "rejected";
}

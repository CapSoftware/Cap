import { db } from "@cap/database";
import { users, videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";
import { transcribeVideo } from "@/lib/transcribe";

type VideoSourceType = (typeof videos.$inferSelect)["source"]["type"];

type QueueVideoTranscriptionResult = {
	success: boolean;
	message: string;
};

export function shouldQueueTranscriptionAfterMediaComplete(
	sourceType: VideoSourceType | undefined,
	isEditUpload: boolean,
) {
	return (
		!isEditUpload &&
		(sourceType === "webMP4" ||
			sourceType === "desktopMP4" ||
			sourceType === "desktopSegments")
	);
}

export function shouldQueueTranscriptionAfterMultipartComplete(
	sourceType: VideoSourceType,
	mediaProcessingPending: boolean,
) {
	return (
		!mediaProcessingPending &&
		(sourceType === "webMP4" || sourceType === "desktopMP4")
	);
}

export async function queueVideoTranscription(
	videoId: Video.VideoId,
): Promise<QueueVideoTranscriptionResult> {
	const [owner] = await db()
		.select({
			id: videos.ownerId,
			isScreenshot: videos.isScreenshot,
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(videos)
		.innerJoin(users, eq(videos.ownerId, users.id))
		.where(eq(videos.id, videoId));

	if (!owner) {
		return { success: false, message: "Video owner does not exist" };
	}
	if (owner.isScreenshot) {
		return { success: true, message: "Screenshot does not need transcription" };
	}

	return transcribeVideo(
		videoId,
		owner.id,
		isAiGenerationEnabledForUser(owner),
	);
}

import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import type { User, Video } from "@cap/web-domain";
import { and, eq, notInArray } from "drizzle-orm";
import { start } from "workflow/api";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";
import { transcribeVideo } from "@/lib/transcribe";
import { finalizeDesktopRecordingWorkflow } from "@/workflows/finalize-desktop-recording";

export { isRetryableDesktopSegmentsFinalizationError } from "@/lib/desktop-segments-retryable-errors";

export type DesktopSegmentsFinalizationStatus = "queued" | "already-processing";

const PROCESSING_MESSAGE = "Muxing segments into MP4...";

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

async function queueEarlySegmentsTranscription({
	videoId,
	userId,
}: {
	videoId: Video.VideoId;
	userId: User.UserId;
}): Promise<void> {
	// An active live transcription is seconds away from promoting itself to
	// canonical (or queueing this exact fallback itself); starting a full
	// pass now would pay for the same audio twice.
	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId));
	if (video?.metadata?.liveTranscript?.status === "active") {
		console.log(
			`[queueEarlySegmentsTranscription] Live transcription active for ${videoId}; deferring to promotion`,
		);
		return;
	}

	const [owner] = await db()
		.select({
			email: users.email,
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(users)
		.where(eq(users.id, userId));

	const result = await transcribeVideo(
		videoId,
		userId,
		isAiGenerationEnabledForUser(owner),
		{ earlyFromSegments: true },
	);

	if (!result.success) {
		console.warn(
			`[queueEarlySegmentsTranscription] Not queued for ${videoId}: ${result.message}`,
		);
	}
}

export async function queueDesktopSegmentsFinalization({
	videoId,
	userId,
}: {
	videoId: Video.VideoId;
	userId: User.UserId;
}): Promise<DesktopSegmentsFinalizationStatus> {
	const result = await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: PROCESSING_MESSAGE,
			processingError: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(videoUploads.videoId, videoId),
				notInArray(videoUploads.phase, ["processing", "generating_thumbnail"]),
			),
		);

	if (getAffectedRows(result) === 0) {
		const [existing] = await db()
			.select({ phase: videoUploads.phase })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId));

		if (existing) {
			return "already-processing";
		}

		try {
			await db().insert(videoUploads).values({
				videoId,
				phase: "processing",
				processingProgress: 0,
				processingMessage: PROCESSING_MESSAGE,
			});
		} catch {
			return "already-processing";
		}
	}

	try {
		await start(finalizeDesktopRecordingWorkflow, [
			{
				videoId,
				userId,
			},
		]);
		// The segments are fully uploaded at this point, so transcription can
		// start right away from the segment audio instead of waiting for the mux
		// into result.mp4. Failures here never block finalization: the workflow
		// re-queues transcription after the mux exactly as before.
		await queueEarlySegmentsTranscription({ videoId, userId }).catch(
			(error) => {
				console.warn(
					`[queueDesktopSegmentsFinalization] Early transcription queue failed for ${videoId}`,
					error,
				);
			},
		);
		return "queued";
	} catch (error) {
		await db()
			.update(videoUploads)
			.set({
				phase: "error",
				processingProgress: 0,
				processingMessage: "Failed to queue segment muxing",
				processingError: error instanceof Error ? error.message : String(error),
				updatedAt: new Date(),
			})
			.where(eq(videoUploads.videoId, videoId));

		throw error;
	}
}

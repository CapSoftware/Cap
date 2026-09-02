import { db } from "@cap/database";
import { users, videos } from "@cap/database/schema";
import type { User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";
import {
	attachWorkflowRun,
	DesktopRecordingSourceBlockedError,
	ensureSegmentProcessingJob,
	getProcessingState,
	isDesktopRecordingJobRecoverable,
	recordWorkflowDispatchFailure,
	SourceCommitPendingError,
} from "@/lib/desktop-recording-jobs";
import type { RecordingVerification } from "@/lib/desktop-recording-verification";
import { transcribeVideo } from "@/lib/transcribe";
import { finalizeDesktopRecordingWorkflow } from "@/workflows/finalize-desktop-recording";

export { isRetryableDesktopSegmentsFinalizationError } from "@/lib/desktop-segments-retryable-errors";

export type DesktopSegmentsFinalizationStatus = "queued" | "already-processing";

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
	verification,
}: {
	videoId: Video.VideoId;
	userId: User.UserId;
	verification?: RecordingVerification;
}): Promise<DesktopSegmentsFinalizationStatus> {
	const { job, created } = await ensureSegmentProcessingJob({
		videoId,
		userId,
		verification,
	});
	let dispatched = false;
	if (created || isDesktopRecordingJobRecoverable(job, new Date())) {
		try {
			const run = await start(finalizeDesktopRecordingWorkflow, [
				{ videoId, userId, generation: job.generation },
			]);
			dispatched = true;
			await attachWorkflowRun({
				videoId,
				generation: job.generation,
				workflowRunId: run.runId,
			});
		} catch (error) {
			await recordWorkflowDispatchFailure({
				videoId,
				generation: job.generation,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			console.error(
				"[queueDesktopSegmentsFinalization] Durable job is waiting for workflow dispatch",
				{ videoId, generation: job.generation, error },
			);
		}
	}
	const current = await getProcessingState({
		videoId,
		generation: job.generation,
	});
	if (current?.state === "source-blocked") {
		throw new DesktopRecordingSourceBlockedError(
			current.errorCode ?? "source-incomplete",
			current.errorMessage ??
				"Recording source is incomplete; uploaded files are retained.",
		);
	}
	if (!current?.source) throw new SourceCommitPendingError();
	if (dispatched && current.source.kind === "segments") {
		await queueEarlySegmentsTranscription({ videoId, userId }).catch(
			(error) => {
				console.warn(
					"[queueDesktopSegmentsFinalization] Early transcription queue failed",
					{ videoId, error },
				);
			},
		);
	}
	return dispatched ? "queued" : "already-processing";
}

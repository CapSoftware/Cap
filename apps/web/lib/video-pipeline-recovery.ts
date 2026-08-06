import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { buildEnv } from "@cap/env";
import type { User, Video } from "@cap/web-domain";
import {
	and,
	asc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { start } from "workflow/api";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";
import { startAiGeneration } from "@/lib/generate-ai";
import { transcribeVideo } from "@/lib/transcribe";
import { processVideoWorkflow } from "@/workflows/process-video";

export const STALLED_PIPELINE_MIN_AGE_MS = 60 * 60 * 1000;
export const STALLED_PIPELINE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const STALLED_MEDIA_RECOVERY_BATCH_SIZE = 50;
export const STALLED_TRANSCRIPTION_RECOVERY_BATCH_SIZE = 50;
export const STALLED_AI_RECOVERY_BATCH_SIZE = 25;

type PipelineRecoveryStatus =
	| "started"
	| "already-claimed"
	| "retry-scheduled"
	| "failed";

type PipelineRecoveryResult = {
	videoId: Video.VideoId;
	status: PipelineRecoveryStatus;
};

type PipelineRecoveryGroup = {
	checked: number;
	statuses: Partial<Record<PipelineRecoveryStatus, number>>;
	results: PipelineRecoveryResult[];
};

export type StalledVideoPipelineRecoverySummary = {
	media: PipelineRecoveryGroup;
	transcription: PipelineRecoveryGroup;
	ai: PipelineRecoveryGroup;
};

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

const summarize = (
	results: PipelineRecoveryResult[],
): PipelineRecoveryGroup => {
	const statuses: PipelineRecoveryGroup["statuses"] = {};
	for (const result of results) {
		statuses[result.status] = (statuses[result.status] ?? 0) + 1;
	}

	return { checked: results.length, statuses, results };
};

async function recoverConcurrently<T extends { videoId: Video.VideoId }>(
	candidates: T[],
	concurrency: number,
	recover: (candidate: T) => Promise<PipelineRecoveryStatus>,
): Promise<PipelineRecoveryResult[]> {
	const results: PipelineRecoveryResult[] = new Array(candidates.length);
	let nextIndex = 0;

	const workers = Array.from(
		{ length: Math.min(Math.max(1, concurrency), candidates.length) },
		async () => {
			while (nextIndex < candidates.length) {
				const index = nextIndex++;
				const candidate = candidates[index];
				if (!candidate) continue;

				let status: PipelineRecoveryStatus;
				try {
					status = await recover(candidate);
				} catch (error) {
					status = "failed";
					console.error(
						`[video-pipeline-recovery] Failed to recover ${candidate.videoId}`,
						error,
					);
				}

				results[index] = { videoId: candidate.videoId, status };
			}
		},
	);

	await Promise.all(workers);
	return results;
}

type MediaCandidate = {
	videoId: Video.VideoId;
	userId: User.UserId;
	bucketId: string | null;
	rawFileKey: string;
	updatedAt: Date;
};

async function recoverMediaCandidate(
	candidate: MediaCandidate,
): Promise<PipelineRecoveryStatus> {
	const claimResult = await db()
		.update(videoUploads)
		.set({
			processingProgress: 0,
			processingMessage: "Restarting video processing",
			processingError: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(videoUploads.videoId, candidate.videoId),
				eq(videoUploads.phase, "processing"),
				eq(videoUploads.processingProgress, 0),
				eq(videoUploads.processingMessage, "Starting video processing..."),
				eq(videoUploads.rawFileKey, candidate.rawFileKey),
				eq(videoUploads.updatedAt, candidate.updatedAt),
			),
		);

	if (getAffectedRows(claimResult) === 0) return "already-claimed";

	try {
		await start(processVideoWorkflow, [
			{
				videoId: candidate.videoId,
				userId: candidate.userId,
				rawFileKey: candidate.rawFileKey,
				bucketId: candidate.bucketId,
			},
		]);

		return "started";
	} catch {
		await db()
			.update(videoUploads)
			.set({
				processingMessage: "Processing recovery will retry automatically",
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(videoUploads.videoId, candidate.videoId),
					eq(videoUploads.phase, "processing"),
				),
			);
		return "retry-scheduled";
	}
}

type TranscriptionCandidate = {
	videoId: Video.VideoId;
	userId: string;
	transcriptionStatus: "PROCESSING" | null;
	updatedAt: Date;
	stripeSubscriptionStatus: string | null;
	thirdPartyStripeSubscriptionId: string | null;
};

async function recoverTranscriptionCandidate(
	candidate: TranscriptionCandidate,
): Promise<PipelineRecoveryStatus> {
	if (candidate.transcriptionStatus === "PROCESSING") {
		const claimResult = await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(
				and(
					eq(videos.id, candidate.videoId),
					eq(videos.transcriptionStatus, "PROCESSING"),
					eq(videos.updatedAt, candidate.updatedAt),
				),
			);

		if (getAffectedRows(claimResult) === 0) return "already-claimed";
	}

	const result = await transcribeVideo(
		candidate.videoId,
		candidate.userId,
		isAiGenerationEnabledForUser(candidate),
	);

	if (!result.success) return "retry-scheduled";
	return result.message === "Transcription workflow started"
		? "started"
		: "already-claimed";
}

type AiCandidate = {
	videoId: Video.VideoId;
	userId: string;
	metadata: VideoMetadata | null;
	updatedAt: Date;
	stripeSubscriptionStatus: string | null;
	thirdPartyStripeSubscriptionId: string | null;
};

async function recoverAiCandidate(
	candidate: AiCandidate,
): Promise<PipelineRecoveryStatus> {
	const metadata = candidate.metadata ?? {};
	const status = metadata.aiGenerationStatus;
	if (status === "QUEUED" || status === "PROCESSING") {
		const claimResult = await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "ERROR",
				},
			})
			.where(
				and(
					eq(videos.id, candidate.videoId),
					eq(videos.updatedAt, candidate.updatedAt),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) = ${status}`,
				),
			);

		if (getAffectedRows(claimResult) === 0) return "already-claimed";
	}

	const result = await startAiGeneration(candidate.videoId, candidate.userId);
	if (!result.success) return "failed";
	return result.message === "AI generation workflow started"
		? "started"
		: "already-claimed";
}

export async function recoverStalledVideoPipeline({
	now = new Date(),
	mediaLimit = STALLED_MEDIA_RECOVERY_BATCH_SIZE,
	transcriptionLimit = STALLED_TRANSCRIPTION_RECOVERY_BATCH_SIZE,
	aiLimit = STALLED_AI_RECOVERY_BATCH_SIZE,
	concurrency = 5,
}: {
	now?: Date;
	mediaLimit?: number;
	transcriptionLimit?: number;
	aiLimit?: number;
	concurrency?: number;
} = {}): Promise<StalledVideoPipelineRecoverySummary> {
	const staleBefore = new Date(now.getTime() - STALLED_PIPELINE_MIN_AGE_MS);
	const recentBefore = new Date(now.getTime() - STALLED_PIPELINE_MAX_AGE_MS);

	const mediaCandidates = await db()
		.select({
			videoId: videos.id,
			userId: videos.ownerId,
			bucketId: videos.bucket,
			rawFileKey: videoUploads.rawFileKey,
			updatedAt: videoUploads.updatedAt,
		})
		.from(videos)
		.innerJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(
			and(
				eq(videoUploads.phase, "processing"),
				eq(videoUploads.processingProgress, 0),
				eq(videoUploads.processingMessage, "Starting video processing..."),
				isNotNull(videoUploads.rawFileKey),
				lte(videoUploads.updatedAt, staleBefore),
				gte(videoUploads.startedAt, recentBefore),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.source}, '$.type')) = 'webMP4'`,
			),
		)
		.orderBy(asc(videoUploads.updatedAt))
		.limit(mediaLimit);

	const transcriptionCandidates = await db()
		.select({
			videoId: videos.id,
			userId: videos.ownerId,
			transcriptionStatus: videos.transcriptionStatus,
			updatedAt: videos.updatedAt,
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
		})
		.from(videos)
		.innerJoin(users, eq(videos.ownerId, users.id))
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(
			and(
				isNull(videoUploads.videoId),
				eq(videos.isScreenshot, false),
				gte(videos.createdAt, recentBefore),
				lte(videos.updatedAt, staleBefore),
				or(
					isNull(videos.transcriptionStatus),
					eq(videos.transcriptionStatus, "PROCESSING"),
				),
			),
		)
		.orderBy(asc(videos.updatedAt))
		.limit(transcriptionLimit);

	const aiScanLimit = buildEnv.NEXT_PUBLIC_IS_CAP ? aiLimit * 4 : aiLimit;
	const aiCandidates = (
		await db()
			.select({
				videoId: videos.id,
				userId: videos.ownerId,
				metadata: videos.metadata,
				updatedAt: videos.updatedAt,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(videos)
			.innerJoin(users, eq(videos.ownerId, users.id))
			.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
			.where(
				and(
					isNull(videoUploads.videoId),
					eq(videos.isScreenshot, false),
					eq(videos.transcriptionStatus, "COMPLETE"),
					gte(videos.createdAt, recentBefore),
					lte(videos.updatedAt, staleBefore),
					or(
						isNull(
							sql`JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')`,
						),
						inArray(
							sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus'))`,
							["QUEUED", "PROCESSING"],
						),
					),
					sql`(${videos.metadata} IS NULL OR JSON_EXTRACT(${videos.metadata}, '$.summary') IS NULL OR JSON_EXTRACT(${videos.metadata}, '$.chapters') IS NULL)`,
				),
			)
			.orderBy(asc(videos.updatedAt))
			.limit(aiScanLimit)
	)
		.filter(isAiGenerationEnabledForUser)
		.slice(0, aiLimit) as AiCandidate[];

	const [media, transcription, ai] = await Promise.all([
		recoverConcurrently(
			mediaCandidates as MediaCandidate[],
			concurrency,
			recoverMediaCandidate,
		),
		recoverConcurrently(
			transcriptionCandidates as TranscriptionCandidate[],
			concurrency,
			recoverTranscriptionCandidate,
		),
		recoverConcurrently(aiCandidates, concurrency, recoverAiCandidate),
	]);

	return {
		media: summarize(media),
		transcription: summarize(transcription),
		ai: summarize(ai),
	};
}

"use server";

import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import {
	isRetryableDesktopSegmentsFinalizationError,
	queueDesktopSegmentsFinalization,
} from "@/lib/desktop-segments-finalization";
import { startAiGeneration } from "@/lib/generate-ai";
import * as EffectRuntime from "@/lib/server";
import { transcribeVideo } from "../../lib/transcribe";
import { isAiGenerationEnabled } from "../../utils/flags";

type TranscriptionStatus =
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED"
	| "NO_AUDIO";

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

export interface VideoStatusResult {
	transcriptionStatus: TranscriptionStatus | null;
	aiGenerationStatus: AiGenerationStatus | null;
	name: string | null;
	aiTitle: string | null;
	summary: string | null;
	chapters: { title: string; start: number }[] | null;
	error?: string;
}

export async function getVideoStatus(
	videoId: Video.VideoId,
): Promise<VideoStatusResult | { success: false }> {
	if (!videoId) throw new Error("Video ID not provided");

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		return yield* Effect.promise(() =>
			db().select().from(videos).where(eq(videos.id, videoId)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit)) return { success: false };

	const video = exit.value[0];
	if (!video) throw new Error("Video not found");

	const metadata: VideoMetadata = (video.metadata as VideoMetadata) || {};

	if (!video.transcriptionStatus && serverEnv().DEEPGRAM_API_KEY) {
		const activeUpload = await db()
			.select({
				videoId: videoUploads.videoId,
				phase: videoUploads.phase,
				processingError: videoUploads.processingError,
			})
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId))
			.limit(1);

		if (activeUpload.length > 0) {
			const upload = activeUpload[0];
			if (
				video.source?.type === "desktopSegments" &&
				upload?.phase === "error" &&
				isRetryableDesktopSegmentsFinalizationError(upload.processingError)
			) {
				queueDesktopSegmentsFinalization({
					videoId,
					userId: video.ownerId,
				}).catch((error) => {
					console.error(
						`[Get Status] Error queueing segment finalization for video ${videoId}:`,
						error,
					);
				});
			}

			return {
				transcriptionStatus: null,
				aiGenerationStatus:
					(metadata.aiGenerationStatus as AiGenerationStatus) || null,
				name: video.name,
				aiTitle: metadata.aiTitle || null,
				summary: metadata.summary || null,
				chapters: metadata.chapters || null,
			};
		}

		console.log(
			`[Get Status] Transcription not started for video ${videoId}, triggering transcription`,
		);
		try {
			transcribeVideo(videoId, video.ownerId).catch((error) => {
				console.error(
					`[Get Status] Error starting transcription for video ${videoId}:`,
					error,
				);
			});

			return {
				transcriptionStatus: "PROCESSING",
				aiGenerationStatus:
					(metadata.aiGenerationStatus as AiGenerationStatus) || null,
				name: video.name,
				aiTitle: metadata.aiTitle || null,
				summary: metadata.summary || null,
				chapters: metadata.chapters || null,
			};
		} catch (error) {
			console.error(
				`[Get Status] Error triggering transcription for video ${videoId}:`,
				error,
			);
			return {
				transcriptionStatus: "ERROR",
				aiGenerationStatus:
					(metadata.aiGenerationStatus as AiGenerationStatus) || null,
				name: video.name,
				aiTitle: metadata.aiTitle || null,
				summary: metadata.summary || null,
				chapters: metadata.chapters || null,
				error: "Failed to start transcription",
			};
		}
	}

	if (video.transcriptionStatus === "ERROR") {
		return {
			transcriptionStatus: "ERROR",
			aiGenerationStatus:
				(metadata.aiGenerationStatus as AiGenerationStatus) || null,
			name: video.name,
			aiTitle: metadata.aiTitle || null,
			summary: metadata.summary || null,
			chapters: metadata.chapters || null,
			error: "Transcription failed",
		};
	}

	const shouldTriggerAiGeneration =
		video.transcriptionStatus === "COMPLETE" &&
		!metadata.aiGenerationStatus &&
		!metadata.summary &&
		(serverEnv().GROQ_API_KEY || serverEnv().OPENAI_API_KEY);

	if (shouldTriggerAiGeneration) {
		try {
			const ownerQuery = await db()
				.select({
					email: users.email,
					stripeSubscriptionStatus: users.stripeSubscriptionStatus,
					thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
				})
				.from(users)
				.where(eq(users.id, video.ownerId))
				.limit(1);

			const owner = ownerQuery[0];
			if (owner && (await isAiGenerationEnabled(owner))) {
				console.log(
					`[Get Status] AI generation not started for video ${videoId}, triggering generation`,
				);
				startAiGeneration(videoId, video.ownerId).catch((error) => {
					console.error(
						`[Get Status] Error starting AI generation for video ${videoId}:`,
						error,
					);
				});

				return {
					transcriptionStatus:
						(video.transcriptionStatus as TranscriptionStatus) || null,
					aiGenerationStatus: "QUEUED" as AiGenerationStatus,
					name: video.name,
					aiTitle: metadata.aiTitle || null,
					summary: metadata.summary || null,
					chapters: metadata.chapters || null,
				};
			}
		} catch (error) {
			console.error(
				`[Get Status] Error checking AI generation eligibility for video ${videoId}:`,
				error,
			);
		}
	}

	return {
		transcriptionStatus:
			(video.transcriptionStatus as TranscriptionStatus) || null,
		aiGenerationStatus:
			(metadata.aiGenerationStatus as AiGenerationStatus) || null,
		name: video.name,
		aiTitle: metadata.aiTitle || null,
		summary: metadata.summary || null,
		chapters: metadata.chapters || null,
	};
}

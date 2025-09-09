"use server";

import { db } from "@cap/database";
import { users, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { revalidatePath } from "next/cache";
import * as EffectRuntime from "@/lib/server";
import { isAiGenerationEnabled } from "@/utils/flags";
import { transcribeVideo } from "../../lib/transcribe";
import { generateAiMetadata } from "./generate-ai-metadata";

const MAX_AI_PROCESSING_TIME = 10 * 60 * 1000;

export interface VideoStatusResult {
	transcriptionStatus: "PROCESSING" | "COMPLETE" | "ERROR" | null;
	aiProcessing: boolean;
	aiTitle: string | null;
	summary: string | null;
	chapters: { title: string; start: number }[] | null;
	// generationError: string | null;
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

	if (!video.transcriptionStatus) {
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
				aiProcessing: false,
				aiTitle: metadata.aiTitle || null,
				summary: metadata.summary || null,
				chapters: metadata.chapters || null,
				// generationError: metadata.generationError || null,
			};
		} catch (error) {
			console.error(
				`[Get Status] Error triggering transcription for video ${videoId}:`,
				error,
			);
			return {
				transcriptionStatus: "ERROR",
				aiProcessing: false,
				aiTitle: metadata.aiTitle || null,
				summary: metadata.summary || null,
				chapters: metadata.chapters || null,
				// generationError: metadata.generationError || null,
				error: "Failed to start transcription",
			};
		}
	}

	if (video.transcriptionStatus === "ERROR") {
		return {
			transcriptionStatus: "ERROR",
			aiProcessing: false,
			aiTitle: metadata.aiTitle || null,
			summary: metadata.summary || null,
			chapters: metadata.chapters || null,
			// generationError: metadata.generationError || null,
			error: "Transcription failed",
		};
	}

	if (metadata.aiProcessing) {
		const updatedAtTime = new Date(video.updatedAt).getTime();
		const currentTime = new Date().getTime();

		if (currentTime - updatedAtTime > MAX_AI_PROCESSING_TIME) {
			console.log(
				`[Get Status] AI processing appears stuck for video ${videoId} (${Math.round(
					(currentTime - updatedAtTime) / 60000,
				)} minutes), resetting flag`,
			);

			await db()
				.update(videos)
				.set({
					metadata: {
						...metadata,
						aiProcessing: false,
						// generationError: "AI processing timed out and was reset",
					},
				})
				.where(eq(videos.id, videoId));

			const updatedResult = await db()
				.select()
				.from(videos)
				.where(eq(videos.id, videoId));
			if (updatedResult.length > 0 && updatedResult[0]) {
				const updatedVideo = updatedResult[0];
				const updatedMetadata = (updatedVideo.metadata as VideoMetadata) || {};

				return {
					transcriptionStatus:
						(updatedVideo.transcriptionStatus as
							| "PROCESSING"
							| "COMPLETE"
							| "ERROR") || null,
					aiProcessing: false,
					aiTitle: updatedMetadata.aiTitle || null,
					summary: updatedMetadata.summary || null,
					chapters: updatedMetadata.chapters || null,
					// generationError: updatedMetadata.generationError || null,
					error: "AI processing timed out and was reset",
				};
			}
		}
	}

	if (
		video.transcriptionStatus === "COMPLETE" &&
		!metadata.aiProcessing &&
		!metadata.summary &&
		!metadata.chapters
		// !metadata.generationError
	) {
		console.log(
			`[Get Status] Transcription complete but no AI data, checking feature flag for video owner ${video.ownerId}`,
		);

		const videoOwnerQuery = await db()
			.select({
				email: users.email,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
			})
			.from(users)
			.where(eq(users.id, video.ownerId))
			.limit(1);

		if (
			videoOwnerQuery.length > 0 &&
			videoOwnerQuery[0] &&
			(await isAiGenerationEnabled(videoOwnerQuery[0]))
		) {
			console.log(
				`[Get Status] Feature flag enabled, triggering AI generation for video ${videoId}`,
			);

			(async () => {
				try {
					console.log(
						`[Get Status] Starting AI metadata generation for video ${videoId}`,
					);
					await generateAiMetadata(videoId, video.ownerId);
					console.log(
						`[Get Status] AI metadata generation completed for video ${videoId}`,
					);
					// Revalidate the share page to reflect new AI data
					revalidatePath(`/s/${videoId}`);
				} catch (error) {
					console.error(
						`[Get Status] Error generating AI metadata for video ${videoId}:`,
						error,
					);

					try {
						const currentVideo = await db()
							.select()
							.from(videos)
							.where(eq(videos.id, videoId));
						if (currentVideo.length > 0 && currentVideo[0]) {
							const currentMetadata =
								(currentVideo[0].metadata as VideoMetadata) || {};
							await db()
								.update(videos)
								.set({
									metadata: {
										...currentMetadata,
										aiProcessing: false,
										// generationError:
										// 	error instanceof Error ? error.message : String(error),
									},
								})
								.where(eq(videos.id, videoId));
						}
						revalidatePath(`/s/${videoId}`);
					} catch (resetError) {
						console.error(
							`[Get Status] Failed to reset AI processing flag for video ${videoId}:`,
							resetError,
						);
					}
				}
			})();

			const updatedVideo = await db()
				.select({
					transcriptionStatus: videos.transcriptionStatus,
					metadata: videos.metadata,
				})
				.from(videos)
				.where(eq(videos.id, videoId))
				.limit(1);
			if (updatedVideo.length > 0) {
				const row = updatedVideo[0];
				if (!row) {
					return {
						transcriptionStatus:
							(video.transcriptionStatus as
								| "PROCESSING"
								| "COMPLETE"
								| "ERROR") || null,
						aiProcessing: metadata.aiProcessing || false,
						aiTitle: metadata.aiTitle || null,
						summary: metadata.summary || null,
						chapters: metadata.chapters || null,
						// generationError: metadata.generationError || null,
					};
				}
				const updatedMetadata = (row.metadata as VideoMetadata) || {};

				return {
					transcriptionStatus:
						(row.transcriptionStatus as "PROCESSING" | "COMPLETE" | "ERROR") ||
						null,
					aiProcessing: updatedMetadata.aiProcessing || false,
					aiTitle: updatedMetadata.aiTitle || null,
					summary: updatedMetadata.summary || null,
					chapters: updatedMetadata.chapters || null,
					// generationError: updatedMetadata.generationError || null,
				};
			}
		} else {
			const videoOwner = videoOwnerQuery[0];
			console.log(
				`[Get Status] AI generation feature disabled for video owner ${video.ownerId} (email: ${videoOwner?.email}, pro: ${videoOwner?.stripeSubscriptionStatus})`,
			);
		}
	}

	return {
		transcriptionStatus:
			(video.transcriptionStatus as "PROCESSING" | "COMPLETE" | "ERROR") ||
			null,
		aiProcessing: metadata.aiProcessing || false,
		aiTitle: metadata.aiTitle || null,
		summary: metadata.summary || null,
		chapters: metadata.chapters || null,
		// generationError: metadata.generationError || null,
	};
}

"use server";

import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { provideOptionalAuth, Storage, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import {
	getLiveTranscriptObjectKey,
	type LiveTranscriptState,
	parseLiveTranscript,
} from "@/lib/live-transcribe-core";
import * as EffectRuntime from "@/lib/server";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export type GetLiveTranscriptResult = {
	success: boolean;
	message: string;
	content?: string;
	state?: LiveTranscriptState;
	updatedAt?: string;
	/** Nothing will ever become available for this caller — stop polling. */
	stop?: boolean;
};

/**
 * Provisional transcript of an instant-mode recording that is still being
 * (or was just) recorded. Only meaningful before the canonical transcription
 * completes; auth mirrors getTranscript exactly.
 */
export async function getLiveTranscript(
	videoId: Video.VideoId,
): Promise<GetLiveTranscriptResult> {
	if (!videoId) {
		return { success: false, message: "Missing video id" };
	}

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		return yield* Effect.promise(() =>
			db().select({ video: videos }).from(videos).where(eq(videos.id, videoId)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit)) {
		return { success: false, stop: true, message: "Video not found" };
	}

	const video = exit.value[0]?.video;
	if (!video) {
		return { success: false, stop: true, message: "Video not found" };
	}

	// Once the canonical transcription resolved — successfully or not — the
	// live transcript is superseded; polling can never produce anything new.
	if (video.transcriptionStatus === "COMPLETE") {
		return { success: false, stop: true, message: "Transcript is ready" };
	}
	if (
		video.transcriptionStatus === "ERROR" ||
		video.transcriptionStatus === "SKIPPED" ||
		video.transcriptionStatus === "NO_AUDIO"
	) {
		return {
			success: false,
			stop: true,
			message: "Transcript is not available",
		};
	}

	try {
		const content = await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
			);

			return yield* bucket.getObject(
				getLiveTranscriptObjectKey(video.ownerId, videoId),
			);
		}).pipe(runPromise);

		if (Option.isNone(content)) {
			return { success: false, message: "Live transcript not available" };
		}

		const artifact = parseLiveTranscript(content.value);
		if (!artifact) {
			return { success: false, message: "Live transcript not available" };
		}

		return {
			success: true,
			message: "Live transcript retrieved successfully",
			content: artifact.vtt,
			state: artifact.state,
			updatedAt: artifact.updatedAt,
		};
	} catch (error) {
		console.error("[getLiveTranscript] Error fetching live transcript:", {
			error: error instanceof Error ? error.message : error,
			videoId,
		});
		return { success: false, message: "Failed to fetch live transcript" };
	}
}

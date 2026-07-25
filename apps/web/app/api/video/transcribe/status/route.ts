import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { makeCurrentUserLayer, VideosPolicy } from "@cap/web-backend";
import { DatabaseError, Policy, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { NextRequest } from "next/server";
import * as EffectRuntime from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	const user = await getCurrentUser();
	const url = new URL(request.url);
	const videoId = url.searchParams.get("videoId") as Video.VideoId;

	if (!user) {
		return Response.json({ auth: false }, { status: 401 });
	}

	if (!videoId) {
		return Response.json(
			{ error: true, message: "videoId not supplied" },
			{ status: 400 },
		);
	}

	// `videoId` is caller-supplied, so an authenticated session is not enough:
	// without this any signed-in user could read the transcription status of
	// someone else's private recording. The `getVideoStatus` server action,
	// which returns this same field, already gates on `canView`.
	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		return yield* Effect.promise(() =>
			db().select().from(videos).where(eq(videos.id, videoId)).limit(1),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(
		// The route already required auth above, so provide the user we have
		// rather than `provideOptionalAuth`, which would re-run
		// getServerSession() and re-query `users`.
		Effect.provide(makeCurrentUserLayer(user)),
		EffectRuntime.runPromiseExit,
	);

	if (Exit.isFailure(exit)) {
		const failure = Cause.failureOption(exit.cause);

		// The 404-for-denied behaviour below is deliberate, so this endpoint
		// can't be used to probe which video IDs exist. A database failure is
		// not a denial though: `canView` reads the video plus its org/space
		// memberships, so an outage in any of those would otherwise be reported
		// as "video does not exist" for a video the caller can actually see.
		if (Option.isSome(failure) && Schema.is(DatabaseError)(failure.value)) {
			console.error(
				"[transcribe/status] database error while checking video access:",
				failure.value.cause,
			);

			return Response.json(
				{ error: true, message: "Failed to fetch transcription status" },
				{ status: 500 },
			);
		}

		return Response.json(
			{ error: true, message: "Video does not exist" },
			{ status: 404 },
		);
	}

	const video = exit.value;

	if (video.length === 0 || !video[0]) {
		return Response.json(
			{ error: true, message: "Video does not exist" },
			{ status: 404 },
		);
	}

	return Response.json(
		{ transcriptionStatus: video[0].transcriptionStatus },
		{ status: 200 },
	);
}

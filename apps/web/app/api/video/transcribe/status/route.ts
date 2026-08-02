import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Policy, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { NextRequest } from "next/server";
import * as EffectRuntime from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	try {
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

		const exit = await Effect.gen(function* () {
			const videosPolicy = yield* VideosPolicy;

			return yield* Effect.promise(() =>
				db().select().from(videos).where(eq(videos.id, videoId)),
			).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
		}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

		if (Exit.isFailure(exit)) {
			const error = Option.getOrUndefined(Cause.failureOption(exit.cause));
			if (
				Schema.is(Policy.PolicyDeniedError)(error) ||
				Schema.is(Video.VerifyVideoPasswordError)(error)
			) {
				return Response.json(
					{ error: true, message: "Video does not exist" },
					{ status: 404 },
				);
			}

			return Response.json(
				{ error: true, message: "An unexpected error occurred" },
				{ status: 500 },
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
	} catch (error) {
		console.error(
			"[transcribe status] Unexpected error checking video access:",
			error,
		);
		return Response.json(
			{ error: true, message: "An unexpected error occurred" },
			{ status: 500 },
		);
	}
}

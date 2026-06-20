import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Policy, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import type { NextRequest } from "next/server";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import * as EffectRuntime from "@/lib/server";

const parseRangeParam = (value: string | null) => {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const normalized =
		trimmed.endsWith("d") || trimmed.endsWith("D")
			? trimmed.slice(0, -1)
			: trimmed;
	const parsed = Number.parseInt(normalized, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
};

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	const url = new URL(request.url);
	const videoId = url.searchParams.get("videoId");
	const rangeParam = url.searchParams.get("range");
	const rangeDays = parseRangeParam(rangeParam);

	if (!videoId) {
		return Response.json({ error: "Video ID is required" }, { status: 400 });
	}

	const id = Video.VideoId.make(videoId);

	// Gate on canView so view counts of private / password-protected videos are
	// not disclosed to unauthorized callers. Public videos, owners, org/space
	// members and password-protected videos with a valid cookie still pass.
	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;
		return yield* Effect.promise(() =>
			db().select({ id: videos.id }).from(videos).where(eq(videos.id, id)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(id)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit) || !exit.value[0]) {
		return Response.json({ error: "Video not found" }, { status: 404 });
	}

	try {
		console.log("videoId", videoId);
		const result = await getVideoAnalytics(videoId, { rangeDays });
		console.log("result", result);
		return Response.json({ count: result.count }, { status: 200 });
	} catch (error) {
		console.error("Error fetching video analytics:", error);
		return Response.json(
			{ error: "Failed to fetch analytics" },
			{ status: 500 },
		);
	}
}

import { provideOptionalAuth, Videos } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import type { NextRequest } from "next/server";
import { runPromise } from "@/lib/server";
import { getHeaders } from "@/utils/helpers";

export async function GET(request: NextRequest) {
	const { searchParams } = request.nextUrl;
	const videoId = searchParams.get("videoId");
	const origin = request.headers.get("origin") as string;

	if (!videoId)
		return new Response(
			JSON.stringify({
				error: true,
				message: "userId or videoId not supplied",
			}),
			{
				status: 400,
				headers: getHeaders(origin),
			},
		);

	try {
		const thumbnailUrl = await Effect.flatMap(Videos, (videos) =>
			videos.getThumbnailURL(Video.VideoId.make(videoId)),
		).pipe(
			provideOptionalAuth,
			Effect.catchIf(
				(error) =>
					error._tag === "PolicyDenied" ||
					error._tag === "VerifyVideoPasswordError",
				() => Effect.succeed(Option.none<string>()),
			),
			runPromise,
		);

		if (Option.isNone(thumbnailUrl))
			return new Response(
				JSON.stringify({
					error: true,
					message: "No thumbnail found for this video",
				}),
				{
					status: 404,
					headers: getHeaders(origin),
				},
			);

		return new Response(JSON.stringify({ screen: thumbnailUrl.value }), {
			status: 200,
			headers: getHeaders(origin),
		});
	} catch (error) {
		return new Response(
			JSON.stringify({
				error: true,
				message: "Error generating thumbnail URL",
				details: error instanceof Error ? error.message : "Unknown error",
			}),
			{
				status: 500,
				headers: getHeaders(origin),
			},
		);
	}
}

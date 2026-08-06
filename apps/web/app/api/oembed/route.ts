import { buildEnv } from "@cap/env";
import { Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { buildOEmbedVideo, parseCapShareUrl } from "@/lib/oembed";
import { getPublicShareVideo } from "@/lib/public-share-video";
import { apiToHandler } from "@/lib/server";

const GetOEmbedParams = Schema.Struct({
	url: Schema.String,
	format: Schema.optional(Schema.String),
	maxwidth: Schema.optional(Schema.String),
	maxheight: Schema.optional(Schema.String),
});

class Api extends HttpApi.make("CapOEmbedApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("getOEmbed")`/api/oembed`.setUrlParams(GetOEmbedParams),
	),
) {}

const jsonResponse = (body: unknown, status = 200) =>
	HttpServerResponse.text(JSON.stringify(body), {
		status,
		contentType: "application/json; charset=utf-8",
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Cache-Control":
				status === 200
					? "public, max-age=300, stale-while-revalidate=3600"
					: "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("getOEmbed", ({ urlParams }) =>
				Effect.gen(function* () {
					if (urlParams.format && urlParams.format !== "json") {
						return jsonResponse(
							{ error: "Only the json oEmbed format is supported" },
							501,
						);
					}
					const videoId = parseCapShareUrl(urlParams.url);
					if (!videoId) {
						return jsonResponse({ error: "Invalid Cap share URL" }, 400);
					}
					const video = yield* Effect.tryPromise(() =>
						getPublicShareVideo(Video.VideoId.make(videoId)),
					);
					if (!video) {
						return jsonResponse({ error: "Video not found" }, 404);
					}
					return jsonResponse(
						buildOEmbedVideo({
							video,
							webUrl: buildEnv.NEXT_PUBLIC_WEB_URL,
							maxWidth: urlParams.maxwidth,
							maxHeight: urlParams.maxheight,
						}),
					);
				}).pipe(
					Effect.catchAll(() =>
						Effect.succeed(
							jsonResponse({ error: "Unable to load video" }, 500),
						),
					),
				),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;

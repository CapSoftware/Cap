import { serverEnv } from "@cap/env";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import {
	DEVELOPER_VIDEO_OEMBED_CACHE_SECONDS,
	developerVideoOEmbedAnswer,
} from "@/lib/developer-video-oembed";
import { apiToHandler } from "@/lib/server";

const Query = Schema.Struct({
	url: Schema.optional(Schema.String),
	format: Schema.optional(Schema.String),
	maxwidth: Schema.optional(Schema.String),
	maxheight: Schema.optional(Schema.String),
});

class Api extends HttpApi.make("DeveloperVideoOEmbedApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("getOEmbed")`/api/developer/oembed`.setUrlParams(Query),
	),
) {}

const json = (body: unknown, status: number) =>
	HttpServerResponse.text(JSON.stringify(body), {
		status,
		contentType: "application/json; charset=utf-8",
		headers: {
			"Access-Control-Allow-Origin": "*",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control":
				status === 200
					? `public, max-age=${DEVELOPER_VIDEO_OEMBED_CACHE_SECONDS}, s-maxage=${DEVELOPER_VIDEO_OEMBED_CACHE_SECONDS}`
					: "no-store",
		},
	});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("getOEmbed", ({ urlParams }) =>
				Effect.tryPromise(() =>
					developerVideoOEmbedAnswer(urlParams, serverEnv().WEB_URL),
				).pipe(
					Effect.map(({ status, body }) => json(body, status)),
					Effect.catchAll((error) =>
						Effect.sync(() => {
							console.error(
								"[developer-oembed] Failed to load the video",
								error,
							);
							return json({ error: "Unable to load video" }, 502);
						}),
					),
				),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);

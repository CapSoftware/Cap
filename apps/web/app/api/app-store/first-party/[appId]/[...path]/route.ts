import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Option, Schema } from "effect";
import { firstPartyConnectionHandler } from "@/lib/app-store/first-party";
import { apiToHandler } from "@/lib/server";

class Api extends HttpApi.make("AppStoreFirstPartyApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post(
			"connection",
			"/api/app-store/first-party/:appId/*",
		).setPath(
			Schema.Struct({ appId: Schema.String.pipe(Schema.maxLength(64)) }),
		),
	),
) {}

const notFound = HttpServerResponse.unsafeJson(
	{ error: "Not found" },
	{ status: 404 },
);

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("connection", ({ path }) =>
				Effect.gen(function* () {
					const handler = firstPartyConnectionHandler(path.appId);
					if (!handler) return notFound;
					const request = yield* HttpServerRequest.HttpServerRequest;
					const url = HttpServerRequest.toURL(request);
					if (Option.isNone(url)) return notFound;
					const body = yield* request.text;
					const response = yield* Effect.promise(() =>
						handler(
							new Request(url.value, {
								method: "POST",
								headers: request.headers,
								body,
							}),
						),
					);
					const text = yield* Effect.promise(() => response.text());
					return HttpServerResponse.text(text, {
						status: response.status,
						contentType:
							response.headers.get("content-type") ?? "application/json",
						headers: { "cache-control": "no-store" },
					});
				}).pipe(
					Effect.catchAll(() =>
						Effect.succeed(
							HttpServerResponse.unsafeJson(
								{ error: "Invalid request" },
								{ status: 400 },
							),
						),
					),
				),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;

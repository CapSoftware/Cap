import { timingSafeEqual } from "node:crypto";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { purgeDeletedDeveloperVideos } from "@/lib/developer-video-purge";
import { apiToHandler } from "@/lib/server";

class Api extends HttpApi.make("DeveloperVideoPurgeApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("purge")`/api/cron/developer-video-purge`
			.addSuccess(
				Schema.Struct({
					purged: Schema.Number,
					failed: Schema.Number,
				}),
			)
			.addError(HttpApiError.Unauthorized)
			.addError(HttpApiError.InternalServerError),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("purge", () =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const secret = process.env.CRON_SECRET;
					if (!secret) return yield* new HttpApiError.InternalServerError();
					const expected = Buffer.from(`Bearer ${secret}`);
					const actual = Buffer.from(request.headers.authorization ?? "");
					if (
						actual.length !== expected.length ||
						!timingSafeEqual(actual, expected)
					)
						return yield* new HttpApiError.Unauthorized();

					const result = yield* Effect.tryPromise(() =>
						purgeDeletedDeveloperVideos(),
					).pipe(
						Effect.tapError((error) =>
							Effect.sync(() =>
								console.error(
									"[developer-video-purge] Failed to purge deleted videos",
									error,
								),
							),
						),
						Effect.mapError(() => new HttpApiError.InternalServerError()),
					);
					if (result.failed > 0)
						return yield* new HttpApiError.InternalServerError();
					return result;
				}),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);
export const dynamic = "force-dynamic";

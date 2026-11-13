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
import { sweepStaleDeveloperUploads } from "@/lib/developer-transcript-storage";
import { expireStaleTranscripts } from "@/lib/developer-transcript-store";
import { apiToHandler } from "@/lib/server";

class Api extends HttpApi.make("DeveloperTranscriptsCleanupApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("cleanup")`/api/cron/developer-transcripts-cleanup`
			.addSuccess(
				Schema.Struct({
					expired: Schema.Number,
					redispatched: Schema.Number,
					swept: Schema.Number,
				}),
			)
			.addError(HttpApiError.Unauthorized)
			.addError(HttpApiError.InternalServerError),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("cleanup", () =>
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

					return yield* Effect.tryPromise(async () => {
						const { expired, redispatched } = await expireStaleTranscripts();
						const { deleted } = await sweepStaleDeveloperUploads(new Date());
						return { expired, redispatched, swept: deleted };
					}).pipe(
						Effect.tapError((error) =>
							Effect.sync(() =>
								console.error(
									"[developer-transcripts-cleanup] Failed to expire transcripts",
									error,
								),
							),
						),
						Effect.mapError(() => new HttpApiError.InternalServerError()),
					);
				}),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);
export const dynamic = "force-dynamic";

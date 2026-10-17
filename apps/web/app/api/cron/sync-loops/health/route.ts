import { timingSafeEqual } from "node:crypto";
import { readLoopsHealth } from "@cap/database/loops/health";
import { Effect, Layer, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "effect/http-api";
import { apiToHandler } from "@/lib/server";

class Api extends HttpApi.make("LoopsHealthApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("health", "/api/cron/sync-loops/health", {
			success: Schema.Struct({
				healthy: Schema.Boolean,
				checkedAt: Schema.String,
				totalJobs: Schema.Number,
				overdueJobs: Schema.Number,
				failingJobs: Schema.Number,
			}),
			error: [HttpApiError.Unauthorized, HttpApiError.InternalServerError],
		}),
	),
) {}

const ApiLive = HttpApiBuilder.layer(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("health", () =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const secret = process.env.LOOPS_HEALTH_SECRET;
					if (!secret) return yield* new HttpApiError.InternalServerError();
					const expected = Buffer.from(`Bearer ${secret}`);
					const actual = Buffer.from(request.headers.authorization ?? "");
					if (
						actual.length !== expected.length ||
						!timingSafeEqual(actual, expected)
					)
						return yield* new HttpApiError.Unauthorized();
					return yield* Effect.tryPromise({
						try: readLoopsHealth,
						catch: () => new HttpApiError.InternalServerError(),
					});
				}),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);
export const maxDuration = 30;
export const dynamic = "force-dynamic";

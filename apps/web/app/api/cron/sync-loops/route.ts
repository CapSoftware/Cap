import { timingSafeEqual } from "node:crypto";
import { customerCopy } from "@cap/database/loops/customer-copy";
import { runLoopsSync } from "@cap/database/loops/worker";
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

class Api extends HttpApi.make("LoopsSyncApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("sync", "/api/cron/sync-loops", {
			success: Schema.Struct({
				enabled: Schema.Boolean,
				processed: Schema.Number,
				failed: Schema.Number,
			}),
			error: [HttpApiError.Unauthorized, HttpApiError.InternalServerError],
		}),
	),
) {}

const ApiLive = HttpApiBuilder.layer(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("sync", () =>
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
					const result = yield* Effect.tryPromise({
						try: () => runLoopsSync(customerCopy),
						catch: () => new HttpApiError.InternalServerError(),
					});
					if (result.failed)
						return yield* new HttpApiError.InternalServerError();
					return result;
				}),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);
export const maxDuration = 120;
export const dynamic = "force-dynamic";

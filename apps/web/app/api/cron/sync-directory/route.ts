import { timingSafeEqual } from "node:crypto";
import { runDirectorySync } from "@cap/database/directory-sync/worker";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { apiToHandler } from "@/lib/server";

class Api extends HttpApi.make("DirectorySyncApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("sync")`/api/cron/sync-directory`
			.addSuccess(
				Schema.Struct({
					enabled: Schema.Boolean,
					processed: Schema.Number,
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
						try: runDirectorySync,
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
export const maxDuration = 60;
export const dynamic = "force-dynamic";

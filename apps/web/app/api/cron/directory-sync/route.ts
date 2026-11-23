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
import { apiToHandler } from "@/lib/server";
import { runDueDirectorySyncs } from "@/lib/sso/directory-sync";

const SYNC_BUDGET_MS = 240_000;

class Api extends HttpApi.make("DirectorySyncApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("sync")`/api/cron/directory-sync`
			.addSuccess(
				Schema.Struct({
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
					return yield* Effect.tryPromise({
						try: () => runDueDirectorySyncs(Date.now() + SYNC_BUDGET_MS),
						catch: () => new HttpApiError.InternalServerError(),
					});
				}),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);
export const maxDuration = 300;
export const dynamic = "force-dynamic";

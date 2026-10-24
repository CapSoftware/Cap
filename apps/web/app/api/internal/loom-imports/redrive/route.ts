import { createHash, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@cap/env";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import {
	type LoomRedriveOutcome,
	redriveLoomImport,
} from "@/lib/loom-import-redrive";
import { apiToHandler } from "@/lib/server";

const MAX_VIDEOS_PER_REQUEST = 25;
const CONCURRENCY = 5;

class Api extends HttpApi.make("LoomImportRedriveApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("redrive")`/api/internal/loom-imports/redrive`
			.setPayload(
				Schema.Struct({
					videoIds: Schema.Array(
						Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{15}$/)),
					).pipe(Schema.minItems(1), Schema.maxItems(MAX_VIDEOS_PER_REQUEST)),
				}),
			)
			.addSuccess(
				Schema.Struct({
					results: Schema.Array(
						Schema.Struct({
							videoId: Schema.String,
							status: Schema.Literal("restarted", "skipped", "failed"),
							reason: Schema.optional(Schema.String),
						}),
					),
				}),
			)
			.addError(HttpApiError.Unauthorized),
	),
) {}

function digest(value: string) {
	return createHash("sha256").update(value, "utf8").digest();
}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("redrive", ({ payload }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const secret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
					const header = request.headers["x-media-server-secret"];
					if (
						!secret ||
						!header ||
						!timingSafeEqual(digest(header), digest(secret))
					)
						return yield* new HttpApiError.Unauthorized();
					const results = yield* Effect.forEach(
						[...new Set(payload.videoIds)],
						(videoId) =>
							Effect.promise(
								(): Promise<LoomRedriveOutcome> =>
									redriveLoomImport(videoId).catch((error) => ({
										videoId,
										status: "failed",
										reason:
											error instanceof Error ? error.message : String(error),
									})),
							),
						{ concurrency: CONCURRENCY },
					);
					return { results };
				}),
			),
		),
	),
);

export const POST = apiToHandler(ApiLive);
export const maxDuration = 300;
export const dynamic = "force-dynamic";

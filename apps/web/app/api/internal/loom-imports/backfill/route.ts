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
	backfillLoomImport,
	type LoomBackfillOutcome,
} from "@/lib/loom-import-backfill";
import { apiToHandler } from "@/lib/server";

const MAX_ITEMS_PER_REQUEST = 25;
const CapId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{15}$/));

class Api extends HttpApi.make("LoomImportBackfillApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("backfill")`/api/internal/loom-imports/backfill`
			.setPayload(
				Schema.Struct({
					organizationId: CapId,
					items: Schema.Array(
						Schema.Struct({
							videoId: CapId,
							ownerEmail: Schema.optional(
								Schema.String.pipe(Schema.maxLength(255)),
							),
							folderId: Schema.optional(CapId),
							effectiveCreatedAt: Schema.optional(
								Schema.String.pipe(Schema.maxLength(64)),
							),
							shareFolderId: Schema.optional(CapId),
						}),
					).pipe(Schema.minItems(1), Schema.maxItems(MAX_ITEMS_PER_REQUEST)),
				}),
			)
			.addSuccess(
				Schema.Struct({
					results: Schema.Array(
						Schema.Struct({
							videoId: Schema.String,
							status: Schema.Literal(
								"updated",
								"unchanged",
								"skipped",
								"failed",
							),
							changes: Schema.Array(Schema.String),
							reason: Schema.optional(Schema.String),
							warning: Schema.optional(Schema.String),
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
			handlers.handle("backfill", ({ payload }) =>
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
						payload.items,
						(item) =>
							Effect.promise(
								(): Promise<LoomBackfillOutcome> =>
									backfillLoomImport(payload.organizationId, item).catch(
										(error) => ({
											videoId: item.videoId,
											status: "failed",
											changes: [],
											reason:
												error instanceof Error ? error.message : String(error),
										}),
									),
							),
						{ concurrency: 1 },
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

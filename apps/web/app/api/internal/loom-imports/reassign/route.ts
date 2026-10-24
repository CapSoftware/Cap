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
	type LoomReassignOutcome,
	reassignLoomImport,
} from "@/lib/loom-import-reassign";
import { apiToHandler } from "@/lib/server";

const MAX_VIDEOS_PER_REQUEST = 25;
const CapId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{15}$/));

class Api extends HttpApi.make("LoomImportReassignApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("reassign")`/api/internal/loom-imports/reassign`
			.setPayload(
				Schema.Struct({
					organizationId: CapId,
					fromUserId: CapId,
					toUserId: CapId,
					videoIds: Schema.Array(CapId).pipe(
						Schema.minItems(1),
						Schema.maxItems(MAX_VIDEOS_PER_REQUEST),
					),
				}),
			)
			.addSuccess(
				Schema.Struct({
					results: Schema.Array(
						Schema.Struct({
							videoId: Schema.String,
							status: Schema.Literal("moved", "skipped", "failed"),
							copiedObjects: Schema.optional(Schema.Number),
							cleanup: Schema.optional(Schema.Literal("done", "failed")),
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
			handlers.handle("reassign", ({ payload }) =>
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
								(): Promise<LoomReassignOutcome> =>
									reassignLoomImport({
										organizationId: payload.organizationId,
										videoId,
										fromUserId: payload.fromUserId,
										toUserId: payload.toUserId,
									}).catch((error) => ({
										videoId,
										status: "failed",
										reason:
											error instanceof Error ? error.message : String(error),
									})),
							),
						{ concurrency: 5 },
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

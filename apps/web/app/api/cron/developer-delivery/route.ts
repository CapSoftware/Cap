import { timingSafeEqual } from "node:crypto";
import { AwsCredentials } from "@cap/web-backend";
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
	readDeliveryLogLocation,
	runDeliveryMetering,
} from "@/lib/infra-delivery-metering";
import {
	databaseDeliveryStore,
	s3DeliveryLogSource,
	storageDeliveryResolver,
} from "@/lib/infra-delivery-store";
import { apiToHandler } from "@/lib/server";

export const maxDuration = 300;

const FILES_UNTIL_MS = 200_000;
const MAX_FILES_PER_RUN = 600;

const MethodCounts = Schema.Struct({
	playlist: Schema.Number,
	"rendition-estimate": Schema.Number,
	"mp4-estimate": Schema.Number,
	audio: Schema.Number,
	"no-rate": Schema.Number,
});

const RunSummary = Schema.Struct({
	success: Schema.Literal(true),
	skipped: Schema.optional(Schema.Literal("not configured")),
	recomputed: Schema.optional(Schema.Array(Schema.String)),
	finalized: Schema.optional(Schema.Array(Schema.String)),
	deferred: Schema.optional(Schema.Array(Schema.String)),
	listed: Schema.optional(Schema.Number),
	processed: Schema.optional(Schema.Number),
	failed: Schema.optional(Schema.Number),
	remaining: Schema.optional(Schema.Number),
	methods: Schema.optional(
		Schema.Struct({
			seconds: MethodCounts,
			requests: MethodCounts,
			unlabelled: Schema.Number,
		}),
	),
	durationMs: Schema.optional(Schema.Number),
});

class Api extends HttpApi.make("DeveloperDeliveryApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("meter")`/api/cron/developer-delivery`
			.addSuccess(RunSummary)
			.addError(HttpApiError.Unauthorized)
			.addError(HttpApiError.InternalServerError),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("meter", () =>
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

					const location = readDeliveryLogLocation(
						process.env.CAP_INFRA_DELIVERY_LOGS,
					);
					if (!location) {
						return {
							success: true as const,
							skipped: "not configured" as const,
						};
					}

					const { credentials } = yield* AwsCredentials;
					const startedAt = Date.now();
					const result = yield* Effect.tryPromise(() =>
						runDeliveryMetering({
							source: s3DeliveryLogSource(
								location,
								credentials,
								process.env.CAP_INFRA_DELIVERY_LOGS_REGION || "us-east-1",
							),
							store: databaseDeliveryStore,
							resolver: storageDeliveryResolver,
							now: new Date(startedAt),
							maxFiles: MAX_FILES_PER_RUN,
							outOfTime: () => Date.now() - startedAt >= FILES_UNTIL_MS,
						}),
					).pipe(
						Effect.tapError((error) =>
							Effect.sync(() =>
								console.error(
									"[developer-delivery] Metering run failed",
									error,
								),
							),
						),
						Effect.mapError(() => new HttpApiError.InternalServerError()),
					);

					return {
						success: true as const,
						...result,
						durationMs: Date.now() - startedAt,
					};
				}),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);
export const dynamic = "force-dynamic";

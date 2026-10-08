import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { apiToHandler } from "@/lib/server";

const HealthResponse = Schema.Struct({
	status: Schema.Literal("ok"),
	timestamp: Schema.Number,
});

const SpeedTestPayload = Schema.Struct({
	payload: Schema.String.pipe(Schema.minLength(1)),
});

const SpeedTestResponse = Schema.Struct({
	success: Schema.Boolean,
	bytesReceived: Schema.Number,
	timestamp: Schema.Number,
});

class DesktopHealthApi extends HttpApi.make("DesktopHealthApi").add(
	HttpApiGroup.make("health")
		.add(
			HttpApiEndpoint.get("checkHealth")`/api/desktop/health`
				.addSuccess(HealthResponse)
				.addError(HttpApiError.InternalServerError),
		)
		.add(
			HttpApiEndpoint.post("speedTest")`/api/desktop/health`
				.setPayload(SpeedTestPayload)
				.addSuccess(SpeedTestResponse)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.InternalServerError),
		),
) {}

const ApiLive = HttpApiBuilder.api(DesktopHealthApi).pipe(
	Layer.provide(
		HttpApiBuilder.group(DesktopHealthApi, "health", (handlers) =>
			handlers
				.handle("checkHealth", () =>
					Effect.succeed({
						status: "ok" as const,
						timestamp: Date.now(),
					}),
				)
				.handle("speedTest", ({ payload }) => {
					const bytes = Buffer.byteLength(payload.payload, "utf8");
					return Effect.succeed({
						success: true,
						bytesReceived: bytes,
						timestamp: Date.now(),
					});
				}),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;

import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { startRenderFarmExport } from "@/lib/render-farm-start";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Dimension = Schema.Int.pipe(Schema.between(16, 4096));

class Api extends HttpApi.make("WebEditorBackgroundExportApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("start", "/api/editor/sessions/:id/background-exports")
			.setPath(Schema.Struct({ id: Schema.String }))
			.setPayload(
				Schema.Struct({
					videoId: Video.VideoId,
					resolution: Schema.Tuple(Dimension, Dimension),
					fps: Schema.Int.pipe(Schema.between(1, 60)),
					compression: Schema.Literal("Maximum", "Social", "Web", "Potato"),
				}),
			)
			.addSuccess(
				Schema.Struct({
					exportId: Schema.String,
					downloadUrl: Schema.String,
				}),
			)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.ServiceUnavailable)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("start", ({ path, payload }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const origin = new URL(request.originalUrl).origin;
					if (request.headers.origin && request.headers.origin !== origin) {
						return yield* new HttpApiError.Forbidden();
					}
					return yield* startRenderFarmExport(
						payload.videoId,
						path.id,
						origin,
						{
							resolution: [payload.resolution[0], payload.resolution[1]],
							fps: payload.fps,
							compression: payload.compression,
						},
					);
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;

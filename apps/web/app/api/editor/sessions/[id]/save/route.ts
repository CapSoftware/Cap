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
import { startRenderFarmSave } from "@/lib/render-farm-start";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

class Api extends HttpApi.make("WebEditorSaveApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("save", "/api/editor/sessions/:id/save")
			.setPath(Schema.Struct({ id: Schema.String }))
			.setPayload(Schema.Struct({ videoId: Video.VideoId }))
			.addSuccess(
				Schema.Struct({
					exportId: Schema.String,
					jobId: Schema.String,
					shareUrl: Schema.String,
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
			handlers.handle("save", ({ path, payload }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const origin = new URL(request.originalUrl).origin;
					if (request.headers.origin && request.headers.origin !== origin) {
						return yield* new HttpApiError.Forbidden();
					}
					return yield* startRenderFarmSave(payload.videoId, path.id, origin);
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;

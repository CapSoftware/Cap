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
import { startWorkerSave } from "@/lib/editor-worker-save";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

class Api extends HttpApi.make("WebEditorWorkerSaveApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("start", "/api/editor/sessions/:id/save/worker")
			.setPath(Schema.Struct({ id: Schema.String }))
			.setPayload(Schema.Struct({ videoId: Video.VideoId }))
			.addSuccess(
				Schema.Struct({ exportId: Schema.String, shareUrl: Schema.String }),
			)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.Conflict)
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
					return yield* startWorkerSave(payload.videoId, path.id, origin);
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;

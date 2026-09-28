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
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { withdrawRenderFarmSave } from "@/lib/render-farm-records";
import {
	canSaveEditorVideo,
	renderFarmSaveUnavailable,
	startRenderFarmSave,
} from "@/lib/render-farm-start";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

class Api extends HttpApi.make("WebEditorSaveApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("target", "/api/editor/sessions/:id/save")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setUrlParams(Schema.Struct({ videoId: Video.VideoId }))
				.addSuccess(
					Schema.Struct({
						renderer: Schema.Literal("farm", "browser"),
						reason: Schema.NullOr(Schema.String),
					}),
				)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
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
		)
		.add(
			HttpApiEndpoint.del("withdraw", "/api/editor/sessions/:id/save")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setUrlParams(Schema.Struct({ videoId: Video.VideoId }))
				.addSuccess(Schema.Void, { status: 204 })
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

const sameOrigin = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest;
	const origin = new URL(request.originalUrl).origin;
	if (request.headers.origin && request.headers.origin !== origin) {
		return yield* new HttpApiError.Forbidden();
	}
	return origin;
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("target", ({ urlParams }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(
							urlParams.videoId,
							true,
						);
						if (!canSaveEditorVideo(video)) {
							return yield* new HttpApiError.Forbidden();
						}
						const reason = yield* Effect.promise(renderFarmSaveUnavailable);
						return reason
							? { renderer: "browser" as const, reason }
							: { renderer: "farm" as const, reason: null };
					}),
				)
				.handle("save", ({ path, payload }) =>
					Effect.gen(function* () {
						const origin = yield* sameOrigin;
						return yield* startRenderFarmSave(payload.videoId, path.id, origin);
					}),
				)
				.handle("withdraw", ({ urlParams }) =>
					Effect.gen(function* () {
						yield* sameOrigin;
						const video = yield* loadEligibleEditorVideo(
							urlParams.videoId,
							true,
						);
						yield* Effect.tryPromise({
							try: () => withdrawRenderFarmSave(video.id),
							catch: () => new HttpApiError.InternalServerError(),
						});
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;
export const DELETE = handler;

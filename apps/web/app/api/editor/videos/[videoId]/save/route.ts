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
import { editorRequestOrigin } from "@/lib/editor-request-origin";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { directRenderLikely } from "@/lib/render-farm-direct-plan";
import { withdrawRenderFarmSave } from "@/lib/render-farm-records";
import {
	canSaveEditorVideo,
	editorSaveRenderer,
	startRenderFarmSave,
} from "@/lib/render-farm-start";
import { renderFarmSaveIsCurrent } from "@/lib/render-farm-status";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const VideoPath = Schema.Struct({ videoId: Video.VideoId });

class Api extends HttpApi.make("WebEditorSaveApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("target", "/api/editor/videos/:videoId/save")
				.setPath(VideoPath)
				.addSuccess(
					Schema.Struct({
						renderer: Schema.Literal("farm", "browser"),
						reason: Schema.NullOr(Schema.String),
					}),
				)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.post("save", "/api/editor/videos/:videoId/save")
				.setPath(VideoPath)
				.addSuccess(Schema.Struct({ shareUrl: Schema.String }))
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.del("withdraw", "/api/editor/videos/:videoId/save")
				.setPath(VideoPath)
				.addSuccess(Schema.Struct({}))
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

const sameOrigin = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest;
	const origin = editorRequestOrigin(
		request.originalUrl,
		request.headers.origin,
	);
	if (!origin) return yield* new HttpApiError.Forbidden();
	return origin;
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("target", ({ path }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(path.videoId, true);
						if (!canSaveEditorVideo(video)) {
							return yield* new HttpApiError.Forbidden();
						}
						if (renderFarmSaveIsCurrent(video.metadata)) {
							return yield* new HttpApiError.Conflict();
						}
						return yield* Effect.promise(() =>
							editorSaveRenderer(directRenderLikely(video.metadata)),
						);
					}),
				)
				.handle("save", ({ path }) =>
					Effect.gen(function* () {
						const origin = yield* sameOrigin;
						const started = yield* startRenderFarmSave(path.videoId, origin);
						return { shareUrl: started.shareUrl };
					}),
				)
				.handle("withdraw", ({ path }) =>
					Effect.gen(function* () {
						yield* sameOrigin;
						const video = yield* loadEligibleEditorVideo(path.videoId, true);
						yield* Effect.tryPromise({
							try: () => withdrawRenderFarmSave(video.id),
							catch: () => new HttpApiError.InternalServerError(),
						});
						return {};
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;
export const DELETE = handler;

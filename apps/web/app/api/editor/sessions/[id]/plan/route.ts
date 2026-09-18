import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import {
	loadEligibleEditorVideo,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

class Api extends HttpApi.make("WebEditorPlanApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("read", "/api/editor/sessions/:id/plan")
			.setPath(Schema.Struct({ id: Schema.String }))
			.setUrlParams(Schema.Struct({ videoId: Video.VideoId }))
			.addSuccess(Schema.Struct({ pro: Schema.Boolean }))
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
			handlers.handle("read", ({ path, urlParams }) =>
				Effect.gen(function* () {
					yield* verifyOwnedEditorSession(urlParams.videoId, path.id);
					const video = yield* loadEligibleEditorVideo(urlParams.videoId);
					return { pro: video.captionsEnabled };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;

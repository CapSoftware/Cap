import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

class Api extends HttpApi.make("WebEditorBrowserPlanApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("plan", "/api/editor/videos/:videoId/plan")
			.setPath(Schema.Struct({ videoId: Video.VideoId }))
			.addSuccess(Schema.Struct({ pro: Schema.Boolean }))
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("plan", ({ path }) =>
				Effect.gen(function* () {
					const video = yield* loadEligibleEditorVideo(path.videoId);
					return { pro: video.captionsEnabled };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;

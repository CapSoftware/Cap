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
	getSignedEditorSources,
	loadEligibleEditorVideo,
} from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

class Api extends HttpApi.make("WebEditorBrowserBootstrapApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("bootstrap", "/api/editor/videos/:videoId/bootstrap")
			.setPath(Schema.Struct({ videoId: Video.VideoId }))
			.addSuccess(
				Schema.Struct({
					videoId: Video.VideoId,
					sources: Schema.Unknown,
				}),
			)
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
			handlers.handle("bootstrap", ({ path }) =>
				Effect.gen(function* () {
					const video = yield* loadEligibleEditorVideo(path.videoId);
					const sources = yield* getSignedEditorSources(video, "browser");
					return { videoId: video.id, sources };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;

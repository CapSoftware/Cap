import {
	HttpAuthMiddleware,
	isAiGenerationLanguage,
	Video,
} from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import {
	readShareTranscriptCaptions,
	requestShareTranscriptCaptions,
	usesEditorCaptionJob,
} from "@/lib/editor-caption-snapshot";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

const CaptionWord = Schema.Struct({
	text: Schema.String,
	start: Schema.Number,
	end: Schema.Number,
});
const CaptionSegment = Schema.Struct({
	id: Schema.String,
	start: Schema.Number,
	end: Schema.Number,
	text: Schema.String,
	words: Schema.Array(CaptionWord),
});
const CaptionSnapshot = Schema.Struct({
	status: Schema.Literal(
		"ready",
		"processing",
		"missing",
		"error",
		"no_audio",
		"disabled",
	),
	captions: Schema.NullOr(
		Schema.Struct({
			segments: Schema.Array(CaptionSegment),
			settings: Schema.Null,
		}),
	),
	message: Schema.NullOr(Schema.String),
});
const CaptionRequest = Schema.Struct({
	language: Schema.optional(Schema.String),
});

class Api extends HttpApi.make("WebEditorBrowserCaptionsApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("status", "/api/editor/videos/:videoId/captions")
				.setPath(Schema.Struct({ videoId: Video.VideoId }))
				.setUrlParams(CaptionRequest)
				.addSuccess(CaptionSnapshot)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.post("generate", "/api/editor/videos/:videoId/captions")
				.setPath(Schema.Struct({ videoId: Video.VideoId }))
				.setPayload(CaptionRequest)
				.addSuccess(CaptionSnapshot)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

// Conflict tells the editor to transcribe through a worker session instead.
const shareTranscriptVideo = Effect.fn(
	"WebEditorCaptions.shareTranscriptVideo",
)(function* (videoId: Video.VideoId, language: string) {
	if (!isAiGenerationLanguage(language))
		return yield* new HttpApiError.BadRequest();
	const video = yield* loadEligibleEditorVideo(videoId, false, true);
	if (usesEditorCaptionJob(video, language))
		return yield* new HttpApiError.Conflict();
	return video;
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("status", ({ path, urlParams }) =>
					Effect.gen(function* () {
						const video = yield* shareTranscriptVideo(
							path.videoId,
							urlParams.language ?? "auto",
						);
						return yield* readShareTranscriptCaptions(video);
					}),
				)
				.handle("generate", ({ path, payload }) =>
					Effect.gen(function* () {
						const video = yield* shareTranscriptVideo(
							path.videoId,
							payload.language ?? "auto",
						);
						const current = yield* readShareTranscriptCaptions(video);
						if (current.status !== "missing" && current.status !== "error") {
							return current;
						}
						return yield* requestShareTranscriptCaptions(video);
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;

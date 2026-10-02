import {
	type AiGenerationLanguage,
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
	generateEditorCaptionJob,
	inspectEditorCaptionJob,
} from "@/lib/editor-caption-job";
import {
	readShareTranscriptCaptions,
	requestShareTranscriptCaptions,
	usesEditorCaptionJob,
} from "@/lib/editor-caption-snapshot";
import {
	loadEligibleEditorVideo,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
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
const CaptionData = Schema.Struct({
	segments: Schema.Array(CaptionSegment),
	settings: Schema.Null,
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
	captions: Schema.NullOr(CaptionData),
	message: Schema.NullOr(Schema.String),
});
const CaptionRequest = Schema.Struct({
	videoId: Video.VideoId,
	language: Schema.optional(Schema.String),
});

class Api extends HttpApi.make("WebEditorCaptionsApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("status", "/api/editor/sessions/:id/captions")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setUrlParams(CaptionRequest)
				.addSuccess(CaptionSnapshot)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.post("generate", "/api/editor/sessions/:id/captions")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setPayload(CaptionRequest)
				.addSuccess(CaptionSnapshot)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

const readSnapshot = Effect.fn("WebEditorCaptions.readSnapshot")(function* (
	videoId: Video.VideoId,
	sessionId: string,
	language: AiGenerationLanguage,
) {
	const video = yield* loadEligibleEditorVideo(videoId, false, true);
	const sessionPath = yield* verifyOwnedEditorSession(videoId, sessionId);
	if (usesEditorCaptionJob(video, language)) {
		const inspected = yield* inspectEditorCaptionJob(
			video,
			sessionPath,
			language,
		);
		return inspected.snapshot;
	}
	return yield* readShareTranscriptCaptions(video);
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("status", ({ path, urlParams }) =>
					Effect.gen(function* () {
						const language = urlParams.language ?? "auto";
						if (!isAiGenerationLanguage(language))
							return yield* new HttpApiError.BadRequest();
						return yield* readSnapshot(urlParams.videoId, path.id, language);
					}),
				)
				.handle("generate", ({ path, payload }) =>
					Effect.gen(function* () {
						const language = payload.language ?? "auto";
						if (!isAiGenerationLanguage(language))
							return yield* new HttpApiError.BadRequest();
						const current = yield* readSnapshot(
							payload.videoId,
							path.id,
							language,
						);
						if (
							current.status === "ready" ||
							current.status === "processing" ||
							current.status === "no_audio" ||
							current.status === "disabled"
						) {
							return current;
						}
						const video = yield* loadEligibleEditorVideo(
							payload.videoId,
							false,
							true,
						);
						if (usesEditorCaptionJob(video, language)) {
							const sessionPath = yield* verifyOwnedEditorSession(
								payload.videoId,
								path.id,
							);
							return yield* generateEditorCaptionJob(
								video,
								sessionPath,
								language,
							);
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

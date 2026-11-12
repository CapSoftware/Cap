import { getCurrentUser } from "@cap/database/auth/session";
import { attachmentContentDisposition } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Schema, Stream } from "effect";
import {
	isMediaServerConfigured,
	streamAudioViaMediaServer,
} from "@/lib/media-client";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { apiToHandler } from "@/lib/server";
import { resolveVideoAudioSource } from "@/lib/video-audio-download";

export const dynamic = "force-dynamic";

const errorFields = { error: Schema.String };

class AudioForbidden extends Schema.TaggedError<AudioForbidden>()(
	"AudioForbidden",
	errorFields,
	HttpApiSchema.annotations({ status: 403 }),
) {}

class AudioNotFound extends Schema.TaggedError<AudioNotFound>()(
	"AudioNotFound",
	errorFields,
	HttpApiSchema.annotations({ status: 404 }),
) {}

class AudioNotReady extends Schema.TaggedError<AudioNotReady>()(
	"AudioNotReady",
	errorFields,
	HttpApiSchema.annotations({ status: 409 }),
) {}

class AudioMissing extends Schema.TaggedError<AudioMissing>()(
	"AudioMissing",
	errorFields,
	HttpApiSchema.annotations({ status: 422 }),
) {}

class AudioRateLimited extends Schema.TaggedError<AudioRateLimited>()(
	"AudioRateLimited",
	errorFields,
	HttpApiSchema.annotations({ status: 429 }),
) {}

class AudioFailed extends Schema.TaggedError<AudioFailed>()(
	"AudioFailed",
	errorFields,
	HttpApiSchema.annotations({ status: 500 }),
) {}

class AudioUnavailable extends Schema.TaggedError<AudioUnavailable>()(
	"AudioUnavailable",
	errorFields,
	HttpApiSchema.annotations({ status: 501 }),
) {}

class AudioExtractionFailed extends Schema.TaggedError<AudioExtractionFailed>()(
	"AudioExtractionFailed",
	errorFields,
	HttpApiSchema.annotations({ status: 502 }),
) {}

const sourceErrors = {
	403: AudioForbidden,
	404: AudioNotFound,
	409: AudioNotReady,
	429: AudioRateLimited,
	500: AudioFailed,
} as const;

class Api extends HttpApi.make("CapWebApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("downloadAudio", "/api/videos/:videoId/audio")
			.setPath(Schema.Struct({ videoId: Video.VideoId }))
			.addError(AudioForbidden)
			.addError(AudioNotFound)
			.addError(AudioNotReady)
			.addError(AudioMissing)
			.addError(AudioRateLimited)
			.addError(AudioFailed)
			.addError(AudioUnavailable)
			.addError(AudioExtractionFailed),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			Effect.succeed(
				handlers.handle("downloadAudio", ({ path }) =>
					Effect.gen(function* () {
						if (!isMediaServerConfigured()) {
							return yield* new AudioUnavailable({
								error: "Audio downloads are not available on this server.",
							});
						}

						const request = yield* HttpServerRequest.HttpServerRequest;
						const source = request.source as Request;

						const user = yield* Effect.promise(() => getCurrentUser());
						const limited = yield* Effect.promise(() =>
							isRateLimited(RATE_LIMIT_IDS.AUDIO_DOWNLOAD, {
								key: user?.id,
								headers: source.headers,
							}),
						);
						if (limited) {
							return yield* new AudioRateLimited({
								error:
									"Too many downloads. Please wait a moment and try again.",
							});
						}

						const audioSource = yield* Effect.promise(() =>
							resolveVideoAudioSource(path.videoId, user),
						);
						if (!audioSource.success) {
							return yield* new sourceErrors[audioSource.status]({
								error: audioSource.error,
							});
						}

						const audio = yield* Effect.tryPromise({
							try: () =>
								streamAudioViaMediaServer(audioSource.sourceUrl, source.signal),
							catch: (cause) => {
								if (!source.signal.aborted) {
									console.error("Error extracting audio for download:", cause);
								}
								return new AudioExtractionFailed({
									error: "Failed to extract audio from this video.",
								});
							},
						});

						if (audio.status === "no-audio") {
							return yield* new AudioMissing({
								error: "This video has no audio to download.",
							});
						}

						return HttpServerResponse.stream(
							Stream.fromReadableStream(
								() => audio.body,
								(cause) => cause,
							),
							{
								contentType: "audio/mpeg",
								headers: {
									"Content-Disposition": attachmentContentDisposition(
										audioSource.filename,
									),
									"Cache-Control": "private, no-store",
									"X-Content-Type-Options": "nosniff",
								},
							},
						);
					}),
				),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);

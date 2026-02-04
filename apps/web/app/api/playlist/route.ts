import { serverEnv } from "@cap/env";
import { provideOptionalAuth, S3Buckets, Videos } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Option, Schema } from "effect";
import { apiToHandler } from "@/lib/server";
import { CACHE_CONTROL_HEADERS } from "@/utils/helpers";
import {
	generateM3U8Playlist,
	generateMasterPlaylist,
} from "@/utils/video/ffmpeg/helpers";

export const dynamic = "force-dynamic";

const GetPlaylistParams = Schema.Struct({
	videoId: Video.VideoId,
	videoType: Schema.Literal("video", "audio", "master", "mp4"),
	variant: Schema.OptionFromUndefinedOr(Schema.Literal("auto", "original")),
	thumbnail: Schema.OptionFromUndefinedOr(Schema.String),
	fileType: Schema.OptionFromUndefinedOr(Schema.String),
});

class Api extends HttpApi.make("CapWebApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("getVideoSrc")`/api/playlist`
			.setUrlParams(GetPlaylistParams)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.Unauthorized)
			.addError(HttpApiError.InternalServerError)
			.addError(HttpApiError.NotFound),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			Effect.gen(function* () {
				const s3Buckets = yield* S3Buckets;
				const videos = yield* Videos;

				return handlers.handle("getVideoSrc", ({ urlParams }) =>
					Effect.gen(function* () {
						const [video] = yield* videos
							.getByIdForViewing(urlParams.videoId)
							.pipe(
								Effect.flatten,
								Effect.catchTag(
									"NoSuchElementException",
									() => new HttpApiError.NotFound(),
								),
							);

						return yield* getPlaylistResponse(video, urlParams);
					}).pipe(
						provideOptionalAuth,
						Effect.tapErrorCause(Effect.logError),
						Effect.catchTags({
							VerifyVideoPasswordError: () => new HttpApiError.Forbidden(),
							PolicyDenied: () => new HttpApiError.Unauthorized(),
							DatabaseError: () => new HttpApiError.InternalServerError(),
							S3Error: () => new HttpApiError.InternalServerError(),
							UnknownException: () => new HttpApiError.InternalServerError(),
						}),
						Effect.provideService(S3Buckets, s3Buckets),
					),
				);
			}),
		),
	),
);

const getPlaylistResponse = (
	video: Video.Video,
	urlParams: (typeof GetPlaylistParams)["Type"],
) =>
	Effect.gen(function* () {
		const [s3, customBucket] = yield* S3Buckets.getBucketAccess(video.bucketId);
		const isMp4Source =
			video.source.type === "desktopMP4" || video.source.type === "webMP4";
		const metadata =
			Option.isSome(video.metadata) && typeof video.metadata.value === "object"
				? (video.metadata.value as Record<string, unknown>)
				: {};
		const maybeEditorSavedRender =
			metadata["editorSavedRender"] &&
			typeof metadata["editorSavedRender"] === "object"
				? (metadata["editorSavedRender"] as {
						status?: string;
						outputKey?: unknown;
					})
				: null;
		const useOriginalVariant =
			Option.isSome(urlParams.variant) &&
			urlParams.variant.value === "original";
		const savedRenderOutputKey =
			!useOriginalVariant &&
			maybeEditorSavedRender?.status === "COMPLETE" &&
			typeof maybeEditorSavedRender.outputKey === "string" &&
			maybeEditorSavedRender.outputKey.length > 0
				? maybeEditorSavedRender.outputKey
				: null;
		const mp4Key =
			savedRenderOutputKey ?? `${video.ownerId}/${video.id}/result.mp4`;

		if (Option.isNone(customBucket)) {
			let redirect = `${video.ownerId}/${video.id}/combined-source/stream.m3u8`;

			if (isMp4Source || urlParams.videoType === "mp4") redirect = mp4Key;
			else if (video.source.type === "MediaConvert")
				redirect = `${video.ownerId}/${video.id}/output/video_recording_000.m3u8`;

			return HttpServerResponse.redirect(
				yield* s3.getSignedObjectUrl(redirect),
			);
		}

		if (
			Option.isSome(urlParams.fileType) &&
			urlParams.fileType.value === "transcription"
		) {
			return yield* s3
				.getObject(`${video.ownerId}/${video.id}/transcription.vtt`)
				.pipe(
					Effect.andThen(
						Option.match({
							onNone: () => new HttpApiError.NotFound(),
							onSome: (c) =>
								HttpServerResponse.text(c).pipe(
									HttpServerResponse.setHeaders({
										...CACHE_CONTROL_HEADERS,
										"Content-Type": "text/vtt",
									}),
								),
						}),
					),
					Effect.withSpan("fetchTranscription"),
				);
		}

		if (
			Option.isSome(urlParams.fileType) &&
			urlParams.fileType.value === "enhanced-audio"
		) {
			const enhancedAudioKey = `${video.ownerId}/${video.id}/enhanced-audio.mp3`;
			return yield* s3.getSignedObjectUrl(enhancedAudioKey).pipe(
				Effect.map(HttpServerResponse.redirect),
				Effect.catchTag("S3Error", () => new HttpApiError.NotFound()),
				Effect.withSpan("fetchEnhancedAudio"),
			);
		}

		yield* Effect.log("Resolving path with custom bucket");

		const videoPrefix = `${video.ownerId}/${video.id}/video/`;
		const audioPrefix = `${video.ownerId}/${video.id}/audio/`;

		return yield* Effect.gen(function* () {
			if (video.source.type === "local") {
				const playlistText =
					(yield* s3.getObject(
						`${video.ownerId}/${video.id}/combined-source/stream.m3u8`,
					)).pipe(Option.getOrNull) ?? "";

				const lines = playlistText.split("\n");

				for (const [index, line] of lines.entries()) {
					if (line.endsWith(".ts")) {
						const url = yield* s3.getSignedObjectUrl(
							`${video.ownerId}/${video.id}/combined-source/${line}`,
						);
						lines[index] = url;
					}
				}

				const playlist = lines.join("\n");

				return HttpServerResponse.text(playlist, {
					headers: CACHE_CONTROL_HEADERS,
				});
			} else if (isMp4Source || urlParams.videoType === "mp4") {
				yield* Effect.log(`Returning path ${mp4Key}`);
				return yield* s3
					.getSignedObjectUrl(mp4Key)
					.pipe(Effect.map(HttpServerResponse.redirect));
			}

			let prefix;
			switch (urlParams.videoType) {
				case "video":
					prefix = videoPrefix;
					break;
				case "audio":
					prefix = audioPrefix;
					break;
				case "master":
					prefix = null;
					break;
			}

			if (prefix === null) {
				const [videoSegment, audioSegment] = yield* Effect.all([
					s3.listObjects({ prefix: videoPrefix, maxKeys: 1 }),
					s3.listObjects({ prefix: audioPrefix, maxKeys: 1 }),
				]);

				let audioMetadata;
				const videoMetadata = yield* s3.headObject(
					videoSegment.Contents?.[0]?.Key ?? "",
				);
				if (audioSegment?.KeyCount && audioSegment?.KeyCount > 0) {
					audioMetadata = yield* s3.headObject(
						audioSegment.Contents?.[0]?.Key ?? "",
					);
				}

				const generatedPlaylist = generateMasterPlaylist(
					videoMetadata?.Metadata?.resolution ?? "",
					videoMetadata?.Metadata?.bandwidth ?? "",
					`${serverEnv().WEB_URL}/api/playlist?videoId=${video.id}&videoType=video`,
					audioMetadata
						? `${serverEnv().WEB_URL}/api/playlist?videoId=${video.id}&videoType=audio`
						: null,
				);

				return HttpServerResponse.text(generatedPlaylist, {
					headers: CACHE_CONTROL_HEADERS,
				});
			}

			const objects = yield* s3.listObjects({
				prefix,
				maxKeys: urlParams.thumbnail ? 1 : undefined,
			});

			const chunksUrls = yield* Effect.all(
				(objects.Contents || []).map((object) =>
					Effect.gen(function* () {
						const url = yield* s3.getSignedObjectUrl(object.Key ?? "");
						const metadata = yield* s3.headObject(object.Key ?? "");

						return {
							url: url,
							duration: metadata?.Metadata?.duration ?? "",
							bandwidth: metadata?.Metadata?.bandwidth ?? "",
							resolution: metadata?.Metadata?.resolution ?? "",
							videoCodec: metadata?.Metadata?.videocodec ?? "",
							audioCodec: metadata?.Metadata?.audiocodec ?? "",
						};
					}),
				),
			);

			const generatedPlaylist = generateM3U8Playlist(chunksUrls);

			return HttpServerResponse.text(generatedPlaylist, {
				headers: CACHE_CONTROL_HEADERS,
			});
		}).pipe(Effect.withSpan("generateUrls"));
	});

const handler = apiToHandler(ApiLive);

export const GET = (r: Request) => handler(r);
export const HEAD = (r: Request) => handler(r);

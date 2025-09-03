import { serverEnv } from "@cap/env";
import {
	provideOptionalAuth,
	S3BucketAccess,
	S3Buckets,
	Videos,
} from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Option, Schema } from "effect";
import { apiToHandler } from "@/lib/server";
import { CACHE_CONTROL_HEADERS } from "@/utils/helpers";
import {
	generateM3U8Playlist,
	generateMasterPlaylist,
} from "@/utils/video/ffmpeg/helpers";

export const revalidate = "force-dynamic";

const GetPlaylistParams = Schema.Struct({
	videoId: Video.VideoId,
	videoType: Schema.Literal("video", "audio", "master", "mp4"),
	thumbnail: Schema.OptionFromUndefinedOr(Schema.String),
	fileType: Schema.OptionFromUndefinedOr(Schema.String),
});

// Add range request parsing utility
const parseRange = (rangeHeader: string, fileSize: number) => {
	const parts = rangeHeader.replace(/bytes=/, "").split("-");
	const start = parseInt(parts[0], 10);
	const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
	return { start, end, chunkSize: end - start + 1 };
};

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

				return handlers.handle("getVideoSrc", ({ urlParams, request }) =>
					Effect.gen(function* () {
						const [video] = yield* videos.getById(urlParams.videoId).pipe(
							Effect.flatten,
							Effect.catchTag(
								"NoSuchElementException",
								() => new HttpApiError.NotFound(),
							),
						);

						const [S3ProviderLayer, customBucket] =
							yield* s3Buckets.getProviderLayer(video.bucketId);

						return yield* getPlaylistResponse(
							video,
							Option.isSome(customBucket),
							urlParams,
							request, // Pass the request to handle range headers
						).pipe(Effect.provide(S3ProviderLayer));
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
					),
				);
			}),
		),
	),
);

const getPlaylistResponse = (
	video: Video.Video,
	isCustomBucket: boolean,
	urlParams: (typeof GetPlaylistParams)["Type"],
	request: HttpServerRequest.HttpServerRequest,
) =>
	Effect.gen(function* () {
		const s3 = yield* S3BucketAccess;

		if (!isCustomBucket) {
			let redirect = `${video.ownerId}/${video.id}/combined-source/stream.m3u8`;

			if (video.source.type === "desktopMP4" || urlParams.videoType === "mp4") {
				redirect = `${video.ownerId}/${video.id}/result.mp4`;

				// Handle range requests for MP4 files (Safari compatibility)
				const rangeHeader = request.headers.range;
				if (rangeHeader) {
					return yield* handleRangeRequest(s3, redirect, rangeHeader, request);
				}
			} else if (video.source.type === "MediaConvert") {
				redirect = `${video.ownerId}/${video.id}/output/video_recording_000.m3u8`;
			}

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
			} else if (video.source.type === "desktopMP4") {
				yield* Effect.log(
					`Returning path ${`${video.ownerId}/${video.id}/result.mp4`}`,
				);

				const s3Path = `${video.ownerId}/${video.id}/result.mp4`;
				const rangeHeader = request.headers.range;

				if (rangeHeader) {
					return yield* handleRangeRequest(s3, s3Path, rangeHeader, request);
				}

				return yield* s3
					.getSignedObjectUrl(s3Path)
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

// Add range request handler for MP4 files
const handleRangeRequest = (
	s3: S3BucketAccess,
	s3Path: string,
	rangeHeader: string,
	request: HttpServerRequest.HttpServerRequest,
) =>
	Effect.gen(function* () {
		// For Safari compatibility, create a signed URL that preserves range headers
		const signedUrl = yield* s3.getSignedObjectUrl(s3Path);

		// Instead of handling ranges ourselves, redirect with proper headers
		// This tells Safari that range requests are supported
		return HttpServerResponse.redirect(signedUrl, {
			status: 302,
			headers: {
				"Accept-Ranges": "bytes",
				"Cache-Control": "public, max-age=3600",
			},
		});
	});

const { handler } = apiToHandler(ApiLive);

export const GET = handler;
export const HEAD = handler;

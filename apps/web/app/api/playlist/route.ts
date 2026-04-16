import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import {
	Database,
	provideOptionalAuth,
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
	HttpServerResponse,
} from "@effect/platform";
import { eq } from "drizzle-orm";
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
	videoType: Schema.Literal(
		"video",
		"audio",
		"master",
		"mp4",
		"raw-preview",
		"segments-master",
		"segments-video",
		"segments-audio",
	),
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

const resolveRawPreviewKey = (video: Video.Video) =>
	Effect.gen(function* () {
		const db = yield* Database;
		const [s3] = yield* S3Buckets.getBucketAccess(video.bucketId);
		const [uploadRecord] = yield* db.use((db) =>
			db
				.select({ rawFileKey: Db.videoUploads.rawFileKey })
				.from(Db.videoUploads)
				.where(eq(Db.videoUploads.videoId, video.id)),
		);

		if (uploadRecord?.rawFileKey) {
			return uploadRecord.rawFileKey;
		}

		if (video.source.type !== "webMP4") {
			return yield* Effect.fail(new HttpApiError.NotFound());
		}

		const candidateKeys = [
			`${video.ownerId}/${video.id}/raw-upload.mp4`,
			`${video.ownerId}/${video.id}/raw-upload.webm`,
		];
		const headResults = yield* Effect.all(
			candidateKeys.map((key) => s3.headObject(key).pipe(Effect.option)),
			{ concurrency: "unbounded" },
		);
		for (const [index, candidateKey] of candidateKeys.entries()) {
			const rawHead = headResults[index];
			if (
				rawHead &&
				Option.isSome(rawHead) &&
				(rawHead.value.ContentLength ?? 0) > 0
			) {
				return candidateKey;
			}
		}

		return yield* Effect.fail(new HttpApiError.NotFound());
	});

const getPlaylistResponse = (
	video: Video.Video,
	urlParams: (typeof GetPlaylistParams)["Type"],
) =>
	Effect.gen(function* () {
		const [s3, customBucket] = yield* S3Buckets.getBucketAccess(video.bucketId);
		const isMp4Source =
			video.source.type === "desktopMP4" || video.source.type === "webMP4";

		if (urlParams.videoType === "raw-preview") {
			const rawFileKey = yield* resolveRawPreviewKey(video);
			return yield* s3
				.getSignedObjectUrl(rawFileKey)
				.pipe(Effect.map(HttpServerResponse.redirect));
		}

		if (
			urlParams.videoType === "segments-master" ||
			urlParams.videoType === "segments-video" ||
			urlParams.videoType === "segments-audio"
		) {
			const segSource = new Video.SegmentsSource({
				videoId: video.id,
				ownerId: video.ownerId,
			});

			const manifestKey = segSource.getManifestKey();
			const manifestContent = yield* s3.getObject(manifestKey).pipe(
				Effect.andThen(
					Option.match({
						onNone: () => Effect.fail(new HttpApiError.NotFound()),
						onSome: (c) => Effect.succeed(c),
					}),
				),
			);

			let parsed: unknown;
			try {
				parsed = JSON.parse(manifestContent);
			} catch {
				return yield* Effect.fail(new HttpApiError.InternalServerError());
			}

			const manifest = yield* Schema.decodeUnknown(Video.SegmentManifest)(
				parsed,
			).pipe(Effect.mapError(() => new HttpApiError.InternalServerError()));
			const hasVideoSegments =
				manifest.video_init_uploaded && manifest.video_segments.length > 0;

			if (urlParams.videoType === "segments-master") {
				if (!hasVideoSegments) {
					return yield* Effect.fail(new HttpApiError.NotFound());
				}

				const videoPlaylistUrl = `${serverEnv().WEB_URL}/api/playlist?videoId=${video.id}&videoType=segments-video`;
				const audioPlaylistUrl = manifest.audio_init_uploaded
					? `${serverEnv().WEB_URL}/api/playlist?videoId=${video.id}&videoType=segments-audio`
					: null;

				let playlist =
					"#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n";
				if (audioPlaylistUrl) {
					playlist += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="default",DEFAULT=YES,AUTOSELECT=YES,URI="${audioPlaylistUrl}"\n`;
					playlist += `#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="audio"\n`;
				} else {
					playlist += "#EXT-X-STREAM-INF:BANDWIDTH=2000000\n";
				}
				playlist += `${videoPlaylistUrl}\n`;

				return HttpServerResponse.text(playlist, {
					headers: {
						...CACHE_CONTROL_HEADERS,
						"Content-Type": "application/vnd.apple.mpegurl",
					},
				});
			}

			const isVideo = urlParams.videoType === "segments-video";
			const initKey = isVideo
				? segSource.getVideoInitKey()
				: segSource.getAudioInitKey();
			const rawSegments = isVideo
				? manifest.video_segments
				: manifest.audio_segments;
			const segments = rawSegments.map(Video.normalizeSegmentEntry);
			const initUploaded = isVideo
				? manifest.video_init_uploaded
				: manifest.audio_init_uploaded;

			if (!initUploaded || segments.length === 0) {
				return yield* Effect.fail(new HttpApiError.NotFound());
			}

			const initUrl = yield* s3.getSignedObjectUrl(initKey);
			const segmentUrls = yield* Effect.all(
				segments.map((seg) => {
					const key = isVideo
						? segSource.getVideoSegmentKey(seg.index)
						: segSource.getAudioSegmentKey(seg.index);
					return s3.getSignedObjectUrl(key);
				}),
				{ concurrency: "unbounded" },
			);

			const targetDuration = Math.ceil(
				segments.reduce((max, seg) => Math.max(max, seg.duration), 0),
			);

			let playlist = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${Math.max(targetDuration, 1)}\n#EXT-X-MEDIA-SEQUENCE:0\n`;
			if (manifest.is_complete) {
				playlist += "#EXT-X-PLAYLIST-TYPE:VOD\n";
			}
			playlist += `#EXT-X-MAP:URI="${initUrl}"\n`;

			for (let i = 0; i < segmentUrls.length; i++) {
				const dur = segments[i]?.duration ?? 3.0;
				playlist += `#EXTINF:${dur.toFixed(3)},\n`;
				playlist += `${segmentUrls[i]}\n`;
			}

			if (manifest.is_complete) {
				playlist += "#EXT-X-ENDLIST\n";
			}

			return HttpServerResponse.text(playlist, {
				headers: {
					...CACHE_CONTROL_HEADERS,
					"Content-Type": "application/vnd.apple.mpegurl",
				},
			});
		}

		if (
			Option.isSome(urlParams.fileType) &&
			urlParams.fileType.value === "thumbnails-vtt"
		) {
			const vttKey = `${video.ownerId}/${video.id}/sprites/thumbnails.vtt`;
			const spriteKey = `${video.ownerId}/${video.id}/sprites/sprite.jpg`;
			return yield* Effect.gen(function* () {
				const vttContent = yield* s3.getObject(vttKey);
				if (Option.isNone(vttContent)) {
					return yield* new HttpApiError.NotFound();
				}
				const spriteUrl = yield* s3.getSignedObjectUrl(spriteKey);
				const resolvedVtt = vttContent.value.replaceAll(
					"__SPRITE_URL__",
					spriteUrl,
				);
				return HttpServerResponse.text(resolvedVtt).pipe(
					HttpServerResponse.setHeaders({
						...CACHE_CONTROL_HEADERS,
						"Content-Type": "text/vtt",
					}),
				);
			}).pipe(
				Effect.catchTag("S3Error", () => new HttpApiError.NotFound()),
				Effect.withSpan("fetchThumbnailsVtt"),
			);
		}

		if (Option.isNone(customBucket)) {
			let redirect = `${video.ownerId}/${video.id}/combined-source/stream.m3u8`;

			if (isMp4Source || urlParams.videoType === "mp4")
				redirect = `${video.ownerId}/${video.id}/result.mp4`;
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
					headers: {
						...CACHE_CONTROL_HEADERS,
						"Content-Type": "application/vnd.apple.mpegurl",
					},
				});
			} else if (isMp4Source) {
				yield* Effect.log(
					`Returning path ${`${video.ownerId}/${video.id}/result.mp4`}`,
				);
				return yield* s3
					.getSignedObjectUrl(`${video.ownerId}/${video.id}/result.mp4`)
					.pipe(Effect.map(HttpServerResponse.redirect));
			}

			if (urlParams.videoType === "master") {
				const [videoSegment, audioSegment] = yield* Effect.all([
					s3.listObjects({ prefix: videoPrefix, maxKeys: 1 }),
					s3.listObjects({ prefix: audioPrefix, maxKeys: 1 }),
				]);

				const videoSegmentKey = videoSegment.Contents?.[0]?.Key;
				if (!videoSegmentKey) {
					return yield* Effect.fail(new HttpApiError.NotFound());
				}

				const videoMetadata = yield* s3.headObject(videoSegmentKey);
				const audioMetadata =
					audioSegment?.KeyCount && audioSegment.KeyCount > 0
						? audioSegment.Contents?.[0]?.Key
							? yield* s3.headObject(audioSegment.Contents[0].Key)
							: undefined
						: undefined;

				const generatedPlaylist = generateMasterPlaylist(
					videoMetadata?.Metadata?.resolution ?? "",
					videoMetadata?.Metadata?.bandwidth ?? "",
					`${serverEnv().WEB_URL}/api/playlist?videoId=${video.id}&videoType=video`,
					audioMetadata
						? `${serverEnv().WEB_URL}/api/playlist?videoId=${video.id}&videoType=audio`
						: null,
				);

				return HttpServerResponse.text(generatedPlaylist, {
					headers: {
						...CACHE_CONTROL_HEADERS,
						"Content-Type": "application/vnd.apple.mpegurl",
					},
				});
			}

			const prefix =
				urlParams.videoType === "video"
					? videoPrefix
					: urlParams.videoType === "audio"
						? audioPrefix
						: undefined;

			if (!prefix) {
				return yield* Effect.fail(new HttpApiError.NotFound());
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
				{ concurrency: "unbounded" },
			);

			const generatedPlaylist = generateM3U8Playlist(chunksUrls);

			return HttpServerResponse.text(generatedPlaylist, {
				headers: {
					...CACHE_CONTROL_HEADERS,
					"Content-Type": "application/vnd.apple.mpegurl",
				},
			});
		}).pipe(Effect.withSpan("generateUrls"));
	});

const handler = apiToHandler(ApiLive);

export const GET = (r: Request) => handler(r);
export const HEAD = (r: Request) => handler(r);

import { Headers, HttpClient, HttpClientResponse } from "@effect/platform";
import { Activity } from "@effect/workflow";
import {
	DatabaseError,
	Loom,
	S3Bucket,
	S3Error,
	Video,
} from "@inflight/web-domain";
import { Effect, Option, Schedule, Schema, Stream } from "effect";

import { S3Buckets } from "../S3Buckets/index.ts";
import { Videos } from "../Videos/index.ts";

export const LoomImportVideoLive = Loom.ImportVideo.toLayer(
	Effect.fn(function* (payload) {
		const videos = yield* Videos;
		const s3Buckets = yield* S3Buckets;
		const http = yield* HttpClient.HttpClient;

		yield* Effect.log("starting loom import workflow");

		yield* Activity.make({
			name: "VerifyURLValid",
			error: Schema.Union(Loom.VideoInvalidError, Loom.ExternalLoomError),
			execute: http
				.get(payload.loom.video.downloadUrl, {
					headers: { range: "bytes=0-0" },
				})
				.pipe(
					Effect.flatMap(HttpClientResponse.filterStatus((s) => s < 400)),
					Effect.catchIf(
						(e) => e._tag === "ResponseError",
						(
							cause,
						): Effect.Effect<
							never,
							Loom.VideoInvalidError | Loom.ExternalLoomError
						> => {
							if (cause.response.status < 500)
								return Effect.fail(
									new Loom.VideoInvalidError({
										cause: "NotFound",
									}),
								);

							return Effect.fail(
								new Loom.ExternalLoomError({ cause: cause.response }),
							);
						},
					),
					Effect.retry({
						schedule: Schedule.exponential("200 millis"),
						times: 3,
						while: (e) => e._tag !== "VideoInvalidError",
					}),
					Effect.catchTag("RequestError", Effect.die),
				),
		});

		const { videoId, customBucketId } = yield* Activity.make({
			name: "CreateVideoRecord",
			error: DatabaseError,
			success: Schema.Struct({
				videoId: Video.VideoId,
				customBucketId: Schema.Option(S3Bucket.S3BucketId),
			}),
			execute: Effect.gen(function* () {
				const loomVideo = payload.loom.video;

				const [_, customBucket] = yield* s3Buckets.getBucketAccessForUser(
					payload.cap.userId,
				);

				const customBucketId = Option.map(customBucket, (b) => b.id);

				const videoId = yield* videos.create({
					ownerId: payload.cap.userId,
					orgId: payload.cap.orgId,
					bucketId: customBucketId,
					source: { type: "desktopMP4" as const },
					name: payload.loom.video.name,
					duration: Option.fromNullable(loomVideo.durationSecs),
					width: Option.fromNullable(loomVideo.width),
					height: Option.fromNullable(loomVideo.height),
					public: true,
					metadata: Option.none(),
					folderId: Option.none(),
					transcriptionStatus: Option.none(),
					importSource: new Video.ImportSource({
						source: "loom",
						id: loomVideo.id,
					}),
				});

				return { videoId, customBucketId };
			}).pipe(
				Effect.retry({
					schedule: Schedule.exponential("200 millis"),
					times: 3,
				}),
			),
		});

		const source = new Video.Mp4Source({
			videoId: videoId,
			ownerId: payload.cap.userId,
		});

		yield* Activity.make({
			name: "DownloadVideo",
			error: Schema.Union(
				S3Error,
				DatabaseError,
				Loom.VideoInvalidError,
				Loom.ExternalLoomError,
			),
			execute: Effect.gen(function* () {
				const [s3Bucket] = yield* s3Buckets.getBucketAccess(customBucketId);

				yield* Effect.log(payload.loom.video.downloadUrl);
				const resp = yield* http
					.get(payload.loom.video.downloadUrl)
					.pipe(
						Effect.catchAll((cause) => new Loom.ExternalLoomError({ cause })),
					);
				const contentLength = yield* Headers.get(
					resp.headers,
					"content-length",
				).pipe(
					Option.map((v) => Number(v)),
					Effect.catchTag(
						"NoSuchElementException",
						() => new Loom.VideoInvalidError({ cause: "InvalidContentLength" }),
					),
				);
				yield* Effect.log(`Downloading ${contentLength} bytes`);

				let downloadedBytes = 0;

				const key = source.getFileKey();

				yield* Effect.gen(function* () {
					// TODO: Connect this with upload progress
					yield* Effect.repeat(
						Effect.gen(function* () {
							const bytes = yield* Effect.succeed(downloadedBytes);
							yield* Effect.log(`Downloaded ${bytes}/${contentLength} bytes`);
						}),
						Schedule.forever.pipe(Schedule.delayed(() => "2 seconds")),
					).pipe(Effect.delay("100 millis"), Effect.forkScoped);

					yield* s3Bucket.putObject(
						key,
						resp.stream.pipe(
							Stream.tap((bytes) => {
								downloadedBytes += bytes.length;
								return Effect.void;
							}),
						),
						{ contentLength },
					);
				}).pipe(Effect.scoped);

				yield* Effect.log(
					`Uploaded video for user '${payload.cap.userId}' at key '${key}'`,
				);
			}),
		});

		return { videoId };
	}),
);

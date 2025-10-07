import { Organisation, S3Bucket, User, Video } from "@cap/web-domain";
import { Headers, HttpClient } from "@effect/platform";
import { Activity, Workflow } from "@effect/workflow";
import { Effect, Option, Schedule, Schema, Stream } from "effect";

import { DatabaseError } from "../Database.ts";
import { S3Buckets } from "../S3Buckets/index.ts";
import { S3Error } from "../S3Buckets/S3BucketAccess.ts";
import { Videos } from "../Videos/index.ts";

export class LoomApiError extends Schema.TaggedError<LoomApiError>(
	"LoomApiError",
)("LoomApiError", { cause: Schema.Unknown }) {}

export const LoomImportVideoError = Schema.Union(
	DatabaseError,
	Video.NotFoundError,
	S3Error,
	LoomApiError,
);

export const LoomImportVideo = Workflow.make({
	name: "LoomImportVideo",
	payload: {
		cap: Schema.Struct({
			userId: User.UserId,
			orgId: Organisation.OrganisationId,
		}),
		loom: Schema.Struct({
			userId: User.UserId,
			orgId: Organisation.OrganisationId,
			video: Schema.Struct({
				id: Video.VideoId,
				name: Schema.String,
				downloadUrl: Schema.String,
				width: Schema.OptionFromNullOr(Schema.Number),
				height: Schema.OptionFromNullOr(Schema.Number),
				fps: Schema.OptionFromNullOr(Schema.Number),
				durationSecs: Schema.OptionFromNullOr(Schema.Number),
			}),
		}),
		attempt: Schema.optional(Schema.Number),
	},
	error: LoomImportVideoError,
	idempotencyKey: (p) =>
		`${p.cap.userId}-${p.loom.orgId}-${p.loom.video.id}-${p.attempt ?? 0}`,
});

export const LoomImportVideoLive = LoomImportVideo.toLayer(
	Effect.fn(function* (payload) {
		const videos = yield* Videos;
		const s3Buckets = yield* S3Buckets;
		const http = yield* HttpClient.HttpClient;

		const { videoId, customBucketId } = yield* Activity.make({
			name: "CreateVideoRecord",
			error: LoomImportVideoError,
			success: Schema.Struct({
				videoId: Video.VideoId,
				customBucketId: Schema.Option(S3Bucket.S3BucketId),
			}),
			execute: Effect.gen(function* () {
				const loomVideo = payload.loom.video;

				const [_, customBucket] = yield* s3Buckets
					.getBucketAccessForUser(payload.cap.userId)
					.pipe(Effect.catchAll(() => Effect.die(null)));

				const customBucketId = Option.map(customBucket, (b) => b.id);

				const videoId = yield* videos.create({
					ownerId: payload.cap.userId,
					orgId: payload.cap.orgId,
					bucketId: customBucketId,
					source: { type: "desktopMP4" as const },
					name: payload.loom.video.name,
					duration: loomVideo.durationSecs,
					width: loomVideo.width,
					height: loomVideo.height,
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
			}),
		});

		const source = new Video.Mp4Source({
			videoId: videoId,
			ownerId: payload.cap.userId,
		});

		const { fileKey } = yield* Activity.make({
			name: "DownloadVideo",
			error: LoomImportVideoError,
			success: Schema.Struct({ fileKey: Schema.String }),
			execute: Effect.gen(function* () {
				const [s3Bucket] = yield* s3Buckets.getBucketAccess(customBucketId);

				const resp = yield* http
					.get(payload.loom.video.downloadUrl)
					.pipe(Effect.catchAll((cause) => new LoomApiError({ cause })));
				const contentLength = Headers.get(resp.headers, "content-length").pipe(
					Option.map((v) => Number(v)),
					Option.getOrUndefined,
				);
				yield* Effect.log(`Downloading ${contentLength} bytes`);

				let downloadedBytes = 0;

				const key = source.getFileKey();

				yield* s3Bucket
					.putObject(
						key,
						resp.stream.pipe(
							Stream.tap((bytes) => {
								downloadedBytes += bytes.length;
								return Effect.void;
							}),
						),
						{ contentLength },
					)
					.pipe(
						Effect.race(
							// TODO: Connect this with upload progress
							Effect.repeat(
								Effect.gen(function* () {
									const bytes = yield* Effect.succeed(downloadedBytes);
									yield* Effect.log(`Downloaded ${bytes} bytes`);
								}),
								Schedule.forever.pipe(Schedule.delayed(() => "2 seconds")),
							).pipe(Effect.delay("100 millis")),
						),
					);

				yield* Effect.log(
					`Uploaded video for user '${payload.cap.userId}' at key '${key}'`,
				);

				return { fileKey: key };
			}),
		});

		return { fileKey, videoId };
	}),
);

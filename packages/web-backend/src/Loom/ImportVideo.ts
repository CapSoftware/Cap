import { Readable } from "node:stream";
import * as Db from "@cap/database/schema";
import { CurrentUser, Loom, S3Bucket } from "@cap/web-domain";
import { ClusterWorkflowEngine } from "@effect/cluster";
import { Headers, HttpClient, HttpServerResponse } from "@effect/platform";
import { Activity, Workflow, WorkflowProxy } from "@effect/workflow";
import { Effect, Layer, Option, Schema, Stream } from "effect";

import { Database, DatabaseError } from "../Database";
import { S3Buckets } from "../S3Buckets";
import { S3BucketAccess } from "../S3Buckets/S3BucketAccess";

export const LoomImportVideoLive = Loom.ImportVideo.toLayer(
	Effect.fn(function* (payload) {
		const s3Buckets = yield* S3Buckets;
		const http = yield* HttpClient.HttpClient;

		yield* Activity.make({
			name: "CreateVideoRecord",
			execute: Effect.gen(function* () {
				// db.execute((db) => db.insert(Db.videos).values([])).pipe(
				// 	Effect.catchAll(() => Effect.die(undefined)),
				// );
			}),
		});

		const [bucketProvider, customBucket] = yield* s3Buckets.getProviderForUser(
			payload.userId,
		);

		yield* Activity.make({
			name: "DownloadVideo",
			execute: Effect.gen(function* () {
				const s3Bucket = yield* S3BucketAccess;

				const key = `/loom/${payload.loomOrgId}/${payload.loomVideoId}`;

				const resp = yield* http.get(payload.downloadUrl);
				yield* s3Bucket
					.putObject(
						key,
						resp.stream.pipe(
							Stream.tap((buffer) =>
								Effect.log(`Downloaded ${buffer.length} bytes`),
							),
							Stream.toReadableStreamRuntime(yield* Effect.runtime()),
							(s) => Readable.fromWeb(s as any),
						),
						{
							contentLength: Headers.get(resp.headers, "content-length").pipe(
								Option.map((v) => Number(v)),
								Option.getOrUndefined,
							),
						},
					);

				yield* Effect.log(`Uploaded video for user '${payload.userId}' at key '${key}'`);
			}).pipe(Effect.provide(bucketProvider)),
		});
	}),
);

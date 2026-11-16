import { timingSafeEqual } from "node:crypto";
import { S3Buckets } from "@cap/web-backend";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
} from "@effect/platform";
import { Effect, Layer, Option, Schema } from "effect";
import {
	purgeDeletedDeveloperVideos,
	purgeFailedDeveloperVideoFiles,
} from "@/lib/developer-video-purge";
import { removeUnrecordedInfraFiles } from "@/lib/infra-video-upload";
import { apiToHandler } from "@/lib/server";

const DEVELOPER_UPLOAD_PREFIX = "developer/";
const INCOMPLETE_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// One run aborts a bounded number of uploads, several at a time, and stops
// listing once its time is up, so a large backlog is worked off over the
// following runs and never runs the function into its limit.
const ABORT_CONCURRENCY = 16;
const ABORT_BUDGET = 5_000;
const ABORT_DEADLINE_MS = 120_000;
const ABORT_TIMEOUT_MS = 10_000;

class Api extends HttpApi.make("DeveloperUploadCleanupApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("cleanup")`/api/cron/developer-upload-cleanup`
			.addSuccess(
				Schema.Struct({
					aborted: Schema.Number,
					failed: Schema.Number,
					moreToAbort: Schema.Boolean,
					removed: Schema.Number,
					purged: Schema.Number,
					purgeFailed: Schema.Number,
				}),
			)
			.addError(HttpApiError.Unauthorized)
			.addError(HttpApiError.InternalServerError),
	),
) {}

const abortStaleUploads = Effect.gen(function* () {
	const startedAt = Date.now();
	const startedBefore = startedAt - INCOMPLETE_UPLOAD_MAX_AGE_MS;
	const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
	let aborted = 0;
	let failed = 0;
	let moreToAbort = false;
	let keyMarker: string | undefined;
	let uploadIdMarker: string | undefined;

	while (true) {
		const page = yield* bucket.multipart.listUploads({
			prefix: DEVELOPER_UPLOAD_PREFIX,
			keyMarker,
			uploadIdMarker,
		});

		const stale = (page.Uploads ?? []).flatMap((upload) =>
			upload.Key &&
			upload.UploadId &&
			upload.Initiated &&
			upload.Initiated.getTime() <= startedBefore
				? [{ key: upload.Key, uploadId: upload.UploadId }]
				: [],
		);
		const remaining = ABORT_BUDGET - aborted - failed;
		const batch = stale.slice(0, remaining);
		const outcomes = yield* Effect.forEach(
			batch,
			({ key, uploadId }) => {
				// Checked before each abort, so queued work stops when time is up
				// and only the aborts already in flight are left to finish.
				if (Date.now() - startedAt >= ABORT_DEADLINE_MS) {
					return Effect.succeed("skipped" as const);
				}
				return bucket.multipart.abort(key, uploadId).pipe(
					Effect.timeoutFail({
						duration: ABORT_TIMEOUT_MS,
						onTimeout: () => new Error("Abort timed out"),
					}),
					Effect.either,
					Effect.map((result) => {
						if (result._tag === "Right") return "aborted" as const;
						console.error(
							"[developer-upload-cleanup] Failed to abort upload",
							key,
							result.left,
						);
						return "failed" as const;
					}),
				);
			},
			{ concurrency: ABORT_CONCURRENCY },
		);
		aborted += outcomes.filter((outcome) => outcome === "aborted").length;
		failed += outcomes.filter((outcome) => outcome === "failed").length;
		const skipped = outcomes.includes("skipped");

		const nextKeyMarker = page.NextKeyMarker;
		const nextUploadIdMarker = page.NextUploadIdMarker;
		const lastPage =
			!page.IsTruncated ||
			!nextKeyMarker ||
			(nextKeyMarker === keyMarker && nextUploadIdMarker === uploadIdMarker);
		if (skipped || batch.length < stale.length) {
			moreToAbort = true;
			break;
		}
		if (lastPage) break;
		if (
			aborted + failed >= ABORT_BUDGET ||
			Date.now() - startedAt >= ABORT_DEADLINE_MS
		) {
			moreToAbort = true;
			break;
		}
		keyMarker = nextKeyMarker;
		uploadIdMarker = nextUploadIdMarker;
	}

	return { aborted, failed, moreToAbort };
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("cleanup", () =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const secret = process.env.CRON_SECRET;
					if (!secret) return yield* new HttpApiError.InternalServerError();
					const expected = Buffer.from(`Bearer ${secret}`);
					const actual = Buffer.from(request.headers.authorization ?? "");
					if (
						actual.length !== expected.length ||
						!timingSafeEqual(actual, expected)
					)
						return yield* new HttpApiError.Unauthorized();

					const result = yield* abortStaleUploads.pipe(
						Effect.tapError((error) =>
							Effect.sync(() =>
								console.error(
									"[developer-upload-cleanup] Failed to list uploads",
									error,
								),
							),
						),
						Effect.mapError(() => new HttpApiError.InternalServerError()),
					);
					const removed = yield* Effect.tryPromise(() =>
						removeUnrecordedInfraFiles(),
					).pipe(
						Effect.tapError((error) =>
							Effect.sync(() =>
								console.error(
									"[developer-upload-cleanup] Failed to remove unrecorded files",
									error,
								),
							),
						),
						Effect.mapError(() => new HttpApiError.InternalServerError()),
					);
					const purge = yield* Effect.tryPromise(() =>
						purgeDeletedDeveloperVideos(),
					).pipe(
						Effect.tapError((error) =>
							Effect.sync(() =>
								console.error(
									"[developer-upload-cleanup] Failed to purge deleted videos",
									error,
								),
							),
						),
						Effect.mapError(() => new HttpApiError.InternalServerError()),
					);
					const failedVideos = yield* Effect.tryPromise(() =>
						purgeFailedDeveloperVideoFiles(),
					).pipe(
						Effect.tapError((error) =>
							Effect.sync(() =>
								console.error(
									"[developer-upload-cleanup] Failed to purge failed videos",
									error,
								),
							),
						),
						Effect.mapError(() => new HttpApiError.InternalServerError()),
					);
					const purgeFailed = purge.failed + failedVideos.failed;
					if (result.failed > 0 || purgeFailed > 0)
						return yield* new HttpApiError.InternalServerError();
					return {
						...result,
						removed,
						purged: purge.purged + failedVideos.purged,
						purgeFailed,
					};
				}),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);
export const dynamic = "force-dynamic";
export const maxDuration = 300;

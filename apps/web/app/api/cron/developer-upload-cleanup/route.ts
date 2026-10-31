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
import { apiToHandler } from "@/lib/server";

const DEVELOPER_UPLOAD_PREFIX = "developer/";
const INCOMPLETE_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

class Api extends HttpApi.make("DeveloperUploadCleanupApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("cleanup")`/api/cron/developer-upload-cleanup`
			.addSuccess(
				Schema.Struct({
					aborted: Schema.Number,
					failed: Schema.Number,
				}),
			)
			.addError(HttpApiError.Unauthorized)
			.addError(HttpApiError.InternalServerError),
	),
) {}

const abortStaleUploads = Effect.gen(function* () {
	const startedBefore = Date.now() - INCOMPLETE_UPLOAD_MAX_AGE_MS;
	const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
	let aborted = 0;
	let failed = 0;
	let keyMarker: string | undefined;
	let uploadIdMarker: string | undefined;

	while (true) {
		const page = yield* bucket.multipart.listUploads({
			prefix: DEVELOPER_UPLOAD_PREFIX,
			keyMarker,
			uploadIdMarker,
		});

		for (const upload of page.Uploads ?? []) {
			if (!upload.Key || !upload.UploadId || !upload.Initiated) continue;
			if (upload.Initiated.getTime() > startedBefore) continue;

			const result = yield* Effect.either(
				bucket.multipart.abort(upload.Key, upload.UploadId),
			);
			if (result._tag === "Right") {
				aborted++;
			} else {
				failed++;
				console.error(
					"[developer-upload-cleanup] Failed to abort upload",
					upload.Key,
					result.left,
				);
			}
		}

		const nextKeyMarker = page.NextKeyMarker;
		const nextUploadIdMarker = page.NextUploadIdMarker;
		if (
			!page.IsTruncated ||
			!nextKeyMarker ||
			(nextKeyMarker === keyMarker && nextUploadIdMarker === uploadIdMarker)
		) {
			break;
		}
		keyMarker = nextKeyMarker;
		uploadIdMarker = nextUploadIdMarker;
	}

	return { aborted, failed };
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
					if (result.failed > 0)
						return yield* new HttpApiError.InternalServerError();
					return result;
				}),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);
export const dynamic = "force-dynamic";

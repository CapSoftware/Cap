import { createReadStream } from "node:fs";
import { S3Buckets } from "@cap/web-backend/src/S3Buckets/index";
import { Effect, ManagedRuntime, Option, Stream } from "effect";
import {
	DEVELOPER_UPLOAD_PREFIX,
	isStaleDeveloperUpload,
	TRANSCRIPT_UPLOAD_URL_TTL_SECONDS,
} from "@/lib/developer-transcripts";

const StorageRuntime = ManagedRuntime.make(S3Buckets.Default);

const defaultBucket = S3Buckets.getBucketAccess(Option.none()).pipe(
	Effect.map(([bucket]) => bucket),
);

const run = <A, E>(effect: Effect.Effect<A, E, S3Buckets>) =>
	StorageRuntime.runPromise(effect);

export function presignDeveloperUpload(
	key: string,
	contentLength: number,
	contentType?: string,
) {
	return run(
		defaultBucket.pipe(
			Effect.flatMap((bucket) =>
				bucket.getPresignedPutUrl(
					key,
					{
						ContentLength: contentLength,
						...(contentType ? { ContentType: contentType } : {}),
					},
					{
						expiresIn: TRANSCRIPT_UPLOAD_URL_TTL_SECONDS,
						...(contentType
							? { signableHeaders: new Set(["content-type"]) }
							: {}),
					},
				),
			),
		),
	);
}

export function developerObjectSize(key: string): Promise<number | null> {
	return run(
		defaultBucket.pipe(
			Effect.flatMap((bucket) =>
				bucket.listObjects({ prefix: key, maxKeys: 2 }),
			),
			Effect.map((listing) => {
				const size = listing.Contents?.find(
					(object) => object.Key === key,
				)?.Size;
				return typeof size === "number" && Number.isFinite(size) ? size : null;
			}),
		),
	);
}

export function developerObjectUrl(key: string) {
	return run(
		defaultBucket.pipe(
			Effect.flatMap((bucket) => bucket.getInternalSignedObjectUrl(key)),
		),
	);
}

export function putDeveloperObject(
	key: string,
	body: string | Uint8Array,
	contentType: string,
) {
	return run(
		defaultBucket.pipe(
			Effect.flatMap((bucket) => bucket.putObject(key, body, { contentType })),
		),
	);
}

export function putDeveloperObjectStream(
	key: string,
	body: ReadableStream<Uint8Array>,
	contentLength: number,
	contentType: string,
) {
	return run(
		defaultBucket.pipe(
			Effect.flatMap((bucket) =>
				bucket.putObject(
					key,
					Stream.fromReadableStream(
						() => body,
						(cause) => cause,
					),
					{ contentType, contentLength },
				),
			),
		),
	);
}

export function putDeveloperObjectFile(
	key: string,
	filePath: string,
	contentLength: number,
	contentType: string,
) {
	return run(
		defaultBucket.pipe(
			Effect.flatMap((bucket) =>
				bucket.putObject(
					key,
					Stream.fromAsyncIterable(
						createReadStream(filePath) as AsyncIterable<Uint8Array>,
						(cause) => cause,
					),
					{ contentType, contentLength },
				),
			),
		),
	);
}

export async function getDeveloperObjectText(
	key: string,
): Promise<string | null> {
	const value = await run(
		defaultBucket.pipe(Effect.flatMap((bucket) => bucket.getObject(key))),
	);
	return Option.getOrNull(value);
}

export async function deleteDeveloperObjects(keys: readonly string[]) {
	await Promise.all(
		keys.map((key) =>
			StorageRuntime.runPromiseExit(
				defaultBucket.pipe(
					Effect.flatMap((bucket) => bucket.deleteObject(key)),
				),
			).then((exit) => {
				if (exit._tag === "Failure") {
					console.error("[developer-transcripts] Failed to delete", key);
				}
			}),
		),
	);
}

export function copyDeveloperObject(fromKey: string, toKey: string) {
	return run(
		defaultBucket.pipe(
			Effect.flatMap((bucket) =>
				bucket.copyObject(`${bucket.bucketName}/${fromKey}`, toKey),
			),
		),
	);
}

const SWEEP_MAX_PAGES = 50;

export function sweepStaleDeveloperUploads(now: Date) {
	return run(
		Effect.gen(function* () {
			const bucket = yield* defaultBucket;
			let deleted = 0;
			let continuationToken: string | undefined;
			for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
				const listing = yield* bucket.listObjects({
					prefix: DEVELOPER_UPLOAD_PREFIX,
					maxKeys: 1000,
					continuationToken,
				});
				const stale = (listing.Contents ?? []).flatMap((object) =>
					object.Key &&
					object.LastModified &&
					isStaleDeveloperUpload(object.Key, object.LastModified, now)
						? [{ Key: object.Key }]
						: [],
				);
				if (stale.length > 0) {
					yield* bucket.deleteObjects(stale);
					deleted += stale.length;
				}
				continuationToken = listing.NextContinuationToken;
				if (!listing.IsTruncated || !continuationToken) break;
			}
			return { deleted };
		}),
	);
}

import { AwsCredentials } from "@cap/web-backend/src/Aws";
import {
	invalidateCloudFrontPaths,
	shareLadderCdnPaths,
} from "@cap/web-backend/src/S3Buckets/cloudfront-invalidation";
import { S3Buckets } from "@cap/web-backend/src/S3Buckets/index";
import { Effect, ManagedRuntime, Option } from "effect";

const StorageRuntime = ManagedRuntime.make(S3Buckets.Default);

const bucket = S3Buckets.getBucketAccess(Option.none()).pipe(
	Effect.map(([access]) => access),
);

function isMissingObject(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current; depth++) {
		if (typeof current !== "object") return false;
		const record = current as {
			name?: unknown;
			$metadata?: { httpStatusCode?: unknown };
			cause?: unknown;
		};
		if (
			record.name === "NotFound" ||
			record.name === "NoSuchKey" ||
			record.$metadata?.httpStatusCode === 404
		) {
			return true;
		}
		current = record.cause;
	}
	return false;
}

export type ShareObjectHead = { bytes: number; etag: string | null };

export async function headShareObject(
	key: string,
): Promise<ShareObjectHead | null> {
	const exit = await StorageRuntime.runPromiseExit(
		bucket.pipe(Effect.flatMap((access) => access.headObject(key))),
	);
	if (exit._tag === "Success") {
		return {
			bytes: exit.value.ContentLength ?? 0,
			etag: exit.value.ETag ?? null,
		};
	}
	const failure =
		exit.cause._tag === "Fail"
			? exit.cause.error
			: exit.cause._tag === "Die"
				? exit.cause.defect
				: exit.cause;
	if (isMissingObject(failure)) return null;
	throw failure instanceof Error
		? failure
		: new Error("Storage request failed", { cause: failure });
}

export function shareObjectReadUrl(
	key: string,
	expiresIn: number,
): Promise<string> {
	return StorageRuntime.runPromise(
		bucket.pipe(
			Effect.flatMap((access) =>
				access.getInternalSignedObjectUrl(key, { expiresIn }),
			),
		),
	);
}

export function shareObjectUploadUrl(
	key: string,
	contentType: string,
	expiresIn: number,
): Promise<string> {
	return StorageRuntime.runPromise(
		bucket.pipe(
			Effect.flatMap((access) =>
				access.getInternalPresignedPutUrl(
					key,
					{ ContentType: contentType },
					{ expiresIn },
				),
			),
		),
	);
}

export function readShareObjectText(key: string): Promise<string | null> {
	return StorageRuntime.runPromise(
		bucket.pipe(
			Effect.flatMap((access) => access.getObject(key)),
			Effect.map(Option.getOrNull),
		),
	);
}

export async function deleteShareObjectsUnder(prefix: string): Promise<number> {
	return StorageRuntime.runPromise(
		bucket.pipe(
			Effect.flatMap((access) =>
				Effect.gen(function* () {
					let deleted = 0;
					let continuationToken: string | undefined;
					for (let page = 0; page < 100; page++) {
						const listed = yield* access.listObjects({
							prefix,
							continuationToken,
						});
						const keys = (listed.Contents ?? [])
							.map((object) => object.Key)
							.filter((key): key is string => !!key?.startsWith(prefix));
						if (keys.length > 0) {
							yield* access.deleteObjects(keys.map((Key) => ({ Key })));
							deleted += keys.length;
						}
						continuationToken = listed.NextContinuationToken;
						if (!listed.IsTruncated || !continuationToken) break;
					}
					return deleted;
				}),
			),
		),
	);
}

export async function listShareObjectPrefixes(base: string): Promise<string[]> {
	return StorageRuntime.runPromise(
		bucket.pipe(
			Effect.flatMap((access) =>
				Effect.gen(function* () {
					const prefixes = new Set<string>();
					let continuationToken: string | undefined;
					for (let page = 0; page < 100; page++) {
						const listed = yield* access.listObjects({
							prefix: base,
							continuationToken,
						});
						for (const object of listed.Contents ?? []) {
							const key = object.Key;
							if (!key?.startsWith(base)) continue;
							const end = key.indexOf("/", base.length);
							if (end > base.length) prefixes.add(key.slice(0, end + 1));
						}
						continuationToken = listed.NextContinuationToken;
						if (!listed.IsTruncated || !continuationToken) break;
					}
					return [...prefixes];
				}),
			),
		),
	);
}

export async function purgeShareLadderCdn(outputPrefix: string): Promise<void> {
	await Effect.runPromise(
		invalidateCloudFrontPaths(shareLadderCdnPaths(outputPrefix)).pipe(
			Effect.provide(AwsCredentials.Default),
		),
	);
}

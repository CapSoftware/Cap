import { S3Buckets } from "@cap/web-backend/src/S3Buckets/index";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
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

export function requestAsSeenByViewer(request: Request): Request {
	const host = (
		request.headers.get("x-forwarded-host") ?? request.headers.get("host")
	)
		?.split(",")[0]
		?.trim();
	if (!host) return request;
	try {
		const url = new URL(request.url);
		const viewer = new URL(`${url.protocol}//${host}`);
		url.hostname = viewer.hostname;
		url.port = viewer.port;
		return new Request(url, { headers: request.headers });
	} catch {
		return request;
	}
}

export function signedDeveloperVideoUrl(
	key: string,
	expiresIn: number,
	request: Request,
): Promise<string> {
	return StorageRuntime.runPromise(
		bucket.pipe(
			Effect.flatMap((access) => access.getSignedObjectUrl(key, { expiresIn })),
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(requestAsSeenByViewer(request)),
			),
		),
	);
}

export function internalDeveloperVideoUrl(
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

export function developerVideoUploadUrl(
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

export function readDeveloperVideoText(key: string): Promise<string | null> {
	return StorageRuntime.runPromise(
		bucket.pipe(
			Effect.flatMap((access) => access.getObject(key)),
			Effect.map(Option.getOrNull),
		),
	);
}

export async function headDeveloperVideoObject(
	key: string,
): Promise<{ bytes: number; contentType: string | null } | null> {
	const exit = await StorageRuntime.runPromiseExit(
		bucket.pipe(Effect.flatMap((access) => access.headObject(key))),
	);
	if (exit._tag === "Success") {
		return {
			bytes: exit.value.ContentLength ?? 0,
			contentType: exit.value.ContentType ?? null,
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

export function developerVideoPrefix(video: {
	appId: string;
	id: string;
}): string {
	return `developer/${video.appId}/${video.id}/`;
}

const DELETE_BATCH = 1000;
const DEVELOPER_PREFIX = /^developer\/[^/]+\/[^/]+\/(?:[^/]+\/)?$/;

// Deletes every object under `prefix` (a video's folder, or one encode inside
// it) that `keep` does not claim. Returns how many objects were removed and
// throws if any delete fails, so the caller can try again later.
export function deleteDeveloperVideoObjects(
	prefix: string,
	keep: (key: string) => boolean = () => false,
): Promise<number> {
	if (!DEVELOPER_PREFIX.test(prefix)) {
		return Promise.reject(new Error(`Refusing to delete under ${prefix}`));
	}
	return StorageRuntime.runPromise(
		Effect.gen(function* () {
			const access = yield* bucket;
			let removed = 0;
			let continuationToken: string | undefined;
			do {
				const page = yield* access.listObjects({
					prefix,
					maxKeys: DELETE_BATCH,
					continuationToken,
				});
				const doomed = (page.Contents ?? [])
					.map((object) => object.Key)
					.filter(
						(key): key is string =>
							typeof key === "string" && key.startsWith(prefix) && !keep(key),
					);
				if (doomed.length > 0) {
					const result = yield* access.deleteObjects(
						doomed.map((Key) => ({ Key })),
					);
					const errors = Option.getOrNull(result)?.Errors ?? [];
					if (errors.length > 0) {
						return yield* Effect.fail(
							new Error(
								`Failed to delete ${errors.length} developer video objects`,
							),
						);
					}
					removed += doomed.length;
				}
				continuationToken = page.IsTruncated
					? page.NextContinuationToken
					: undefined;
			} while (continuationToken);
			return removed;
		}),
	);
}

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

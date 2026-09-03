import {
	provideOptionalAuth,
	Storage,
	Videos,
	VideosRepo,
	verifyStorageObjectToken,
} from "@cap/web-backend";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import { isInternalRecordingKey } from "@cap/web-backend/src/Storage/recording-output";
import { Storage as StorageDomain, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import type { NextRequest } from "next/server";
import { isPrivateEditTranscriptObjectKey } from "@/lib/edit-transcript";
import { runPromise } from "@/lib/server";
import { CACHE_CONTROL_HEADERS } from "@/utils/helpers";

export const dynamic = "force-dynamic";

const copyHeader = (
	source: Headers,
	target: Headers,
	sourceName: string,
	targetName = sourceName,
) => {
	const value = source.get(sourceName);
	if (value) target.set(targetName, value);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;

const getErrorTag = (error: unknown) => {
	const record = asRecord(error);
	const tag = record?._tag;
	return typeof tag === "string" ? tag : null;
};

const getErrorText = (error: unknown): string => {
	if (error instanceof Error) {
		const record = asRecord(error);
		const cause = record?.cause;
		if (cause !== undefined && cause !== error) {
			return `${error.message} ${getErrorText(cause)}`;
		}
		return error.message;
	}
	if (typeof error === "string") return error;
	const record = asRecord(error);
	const cause = record?.cause;
	if (cause !== undefined && cause !== error) return getErrorText(cause);
	return String(error);
};

const isStorageError = (error: unknown) =>
	error instanceof StorageDomain.StorageError ||
	getErrorTag(error) === "StorageError";

const isPolicyDeniedError = (error: unknown) =>
	getErrorTag(error) === "PolicyDenied";

const isObjectNotFoundError = (error: unknown) => {
	if (error === "not-found") return true;
	if (!isStorageError(error)) return false;
	const message = getErrorText(error);
	return (
		message.includes("Storage object not found") ||
		message.includes("Google Drive object not found") ||
		message.includes("Google Drive request failed: 404")
	);
};

const toProxyErrorResponse = (error: unknown) => {
	const recordingReadStatus = getRecordingReadStatus(error);
	if (recordingReadStatus) {
		return new Response(
			recordingReadStatus === 412 ? "Object changed" : "Object is unavailable",
			{ status: recordingReadStatus },
		);
	}
	if (isObjectNotFoundError(error) || isPolicyDeniedError(error)) {
		return new Response("Not found", { status: 404 });
	}
	if (isStorageError(error)) {
		return new Response("Storage upstream error", { status: 502 });
	}
	return new Response("Internal server error", { status: 500 });
};

const getRecordingReadStatus = (error: unknown): 412 | 503 | undefined => {
	const record = asRecord(error);
	if (
		record?._tag === "RecordingObjectReadError" &&
		(record.status === 412 || record.status === 503)
	) {
		return record.status;
	}
	return record?.cause && record.cause !== error
		? getRecordingReadStatus(record.cause)
		: undefined;
};

const getTokenVideo = (videoId: Video.VideoId) =>
	Effect.gen(function* () {
		const repo = yield* VideosRepo;
		const maybeVideo = yield* repo.getById(videoId);
		if (Option.isNone(maybeVideo)) return yield* Effect.fail("not-found");
		return maybeVideo.value[0];
	});

const getPolicyVideo = (videoId: Video.VideoId) =>
	Effect.gen(function* () {
		const videos = yield* Videos;
		const maybeVideo = yield* videos.getByIdForViewing(videoId).pipe(
			Effect.flatten,
			Effect.catchTag("NoSuchElementException", () =>
				Effect.fail("not-found" as const),
			),
		);
		return maybeVideo[0];
	});

export async function GET(request: NextRequest) {
	const videoIdParam = request.nextUrl.searchParams.get("videoId");
	const key = request.nextUrl.searchParams.get("key");
	const token = request.nextUrl.searchParams.get("token");

	if (!videoIdParam || !key) {
		return new Response("Missing videoId or key", { status: 400 });
	}
	if (isPrivateEditTranscriptObjectKey(key)) {
		return new Response("Not found", { status: 404 });
	}

	const effect = Effect.gen(function* () {
		const tokenPayload = token ? verifyStorageObjectToken(token) : null;
		const videoId = Video.VideoId.make(videoIdParam);
		const video =
			tokenPayload?.videoId === videoIdParam && tokenPayload.key === key
				? yield* getTokenVideo(videoId)
				: yield* getPolicyVideo(videoId);

		if (!key.startsWith(`${video.ownerId}/${video.id}/`)) {
			return yield* Effect.fail("not-found" as const);
		}
		if (
			isInternalRecordingKey(key) &&
			!(tokenPayload?.videoId === videoIdParam && tokenPayload.key === key) &&
			!(
				video.source.type === "desktopMP4" &&
				[
					key === video.source.outputKey,
					key === video.source.thumbnailKey,
					key === video.source.previewKey,
				].some(Boolean)
			)
		) {
			return yield* Effect.fail("not-found" as const);
		}

		const [storage] = yield* Storage.getAccessForVideo(video);
		if (!("getObjectResponse" in storage)) {
			const url = yield* storage.getSignedObjectUrl(key);
			return Response.redirect(url);
		}

		const verificationRequested =
			request.headers.get("x-cap-recording-verification") === "1";
		const expectedIdentity = request.headers.get("if-match");
		const head = verificationRequested
			? yield* storage.headObject(key)
			: undefined;
		const identity = head
			? getRecordingObjectIdentity(head, expectedIdentity ?? undefined)
			: undefined;
		if (verificationRequested && !identity) {
			return new Response("Object identity is unavailable", { status: 503 });
		}
		if (
			verificationRequested &&
			expectedIdentity &&
			expectedIdentity !== identity
		) {
			return new Response("Object changed", { status: 412 });
		}
		if (
			verificationRequested &&
			request.method === "HEAD" &&
			head &&
			identity
		) {
			const headers = new Headers(CACHE_CONTROL_HEADERS);
			headers.set("ETag", identity);
			headers.set("Accept-Ranges", "bytes");
			if (head.ContentLength !== undefined)
				headers.set("Content-Length", String(head.ContentLength));
			if (head.ContentType) headers.set("Content-Type", head.ContentType);
			return new Response(null, { status: 200, headers });
		}
		const upstream = identity
			? yield* storage.getObjectResponse(key, request.headers.get("range"), {
					objectIdentity: identity,
					signal: request.signal,
				})
			: yield* storage.getObjectResponse(key, request.headers.get("range"));
		const headers = new Headers(CACHE_CONTROL_HEADERS);
		if (identity) headers.set("ETag", identity);
		copyHeader(upstream.headers, headers, "content-type", "Content-Type");
		copyHeader(upstream.headers, headers, "content-length", "Content-Length");
		copyHeader(upstream.headers, headers, "content-range", "Content-Range");
		copyHeader(upstream.headers, headers, "accept-ranges", "Accept-Ranges");
		if (!headers.has("Accept-Ranges")) headers.set("Accept-Ranges", "bytes");

		return new Response(upstream.body, {
			status: upstream.status,
			headers,
		});
	}).pipe(
		provideOptionalAuth,
		Effect.catchAll((error) => Effect.succeed(toProxyErrorResponse(error))),
	);

	try {
		return await runPromise(effect);
	} catch (error) {
		return toProxyErrorResponse(error);
	}
}

export const HEAD = GET;

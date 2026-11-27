import { timingSafeEqual } from "node:crypto";
import { serverEnv } from "@cap/env";
import {
	attachmentContentDisposition,
	provideOptionalAuth,
	Storage,
	Videos,
	VideosRepo,
	verifyStorageObjectToken,
} from "@cap/web-backend";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import { isInternalRecordingKey } from "@cap/web-backend/src/Storage/recording-output";
import { CurrentUser, Storage as StorageDomain, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import type { NextRequest } from "next/server";
import { isPrivateEditTranscriptObjectKey } from "@/lib/edit-transcript";
import { readDeclaredLength } from "@/lib/free-plan-declared-length";
import {
	isVideoOverFreePlanDuration,
	recordFreePlanOverLength,
} from "@/lib/free-plan-measure";
import { firstViewDecision } from "@/lib/free-plan-measure-probe";
import { runPromise } from "@/lib/server";
import { isVideoLockedByShareableLinkLimit } from "@/lib/shareable-link-quota";
import { playbackUrlValidity } from "@/lib/signed-url-validity";
import { isEditSourceObjectKey } from "@/lib/video-edit-processing";
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

const INLINE_CONTENT_TYPES = new Set([
	"video/mp4",
	"video/webm",
	"video/quicktime",
	"video/x-matroska",
	"video/x-msvideo",
	"video/x-m4v",
	"video/mp2t",
	"video/mpeg",
	"video/ogg",
	"video/3gpp",
	"audio/mp4",
	"audio/mpeg",
	"audio/aac",
	"audio/webm",
	"audio/ogg",
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"text/vtt",
	"application/vnd.apple.mpegurl",
	"application/x-mpegurl",
	"application/json",
]);

const setObjectContentHeaders = (
	headers: Headers,
	contentType: string | null | undefined,
) => {
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
	const essence = contentType?.split(";")[0]?.trim().toLowerCase();
	if (contentType && essence && INLINE_CONTENT_TYPES.has(essence)) {
		headers.set("Content-Type", contentType);
		return;
	}
	headers.set("Content-Type", "application/octet-stream");
	headers.set("Content-Disposition", "attachment");
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

const isPlayableMediaKey = (key: string) =>
	/\.(mp4|m4v|mov|webm|mkv|m4s|ts|m3u8|aac|m4a|mp3|opus|ogg|wav)$/i.test(key);

const isWholeVideoKey = (key: string) => /\.(mp4|m4v|mov|webm|mkv)$/i.test(key);

const DECLARED_LENGTH_CACHE_MS = 30_000;
const MAX_DECLARED_LENGTH_ENTRIES = 5_000;
const declaredLengths = new Map<
	string,
	{ declared: { key: string; seconds: number } | null; until: number }
>();

// Segments and playlists are read many times per view, so the playlist is
// read at most every 30 s per video. The plan is checked on every read, so an
// upgrade lifts the hold at once.
const isHeldByDeclaredLength = <E, R>(
	video: { id: Video.VideoId; ownerId: string; source: { type: string } },
	getObject: (key: string) => Effect.Effect<string | null, E, R>,
) =>
	Effect.gen(function* () {
		const cached = declaredLengths.get(video.id);
		const declared =
			cached && cached.until > Date.now()
				? cached.declared
				: yield* readDeclaredLength(video, getObject);
		if (!cached || cached.until <= Date.now()) {
			if (declaredLengths.size >= MAX_DECLARED_LENGTH_ENTRIES)
				declaredLengths.clear();
			declaredLengths.set(video.id, {
				declared,
				until: Date.now() + DECLARED_LENGTH_CACHE_MS,
			});
		}
		if (!declared) return false;
		return yield* Effect.tryPromise(() =>
			recordFreePlanOverLength(video.id, declared.key, declared.seconds),
		);
	});

export async function GET(request: NextRequest) {
	const internalDownload =
		request.headers.get("x-cap-internal-download") === "1";
	if (internalDownload) {
		const expected = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
		const provided = request.headers.get("x-media-server-secret");
		if (
			!expected ||
			!provided ||
			Buffer.byteLength(expected) !== Buffer.byteLength(provided) ||
			!timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
		) {
			return new Response("Unauthorized", { status: 401 });
		}
	}

	const videoIdParam = request.nextUrl.searchParams.get("videoId");
	const key = request.nextUrl.searchParams.get("key");
	const token = request.nextUrl.searchParams.get("token");
	const downloadName = request.nextUrl.searchParams.get("download");

	if (!videoIdParam || !key) {
		return new Response("Missing videoId or key", { status: 400 });
	}
	if (isPrivateEditTranscriptObjectKey(key)) {
		return new Response("Not found", { status: 404 });
	}

	const effect = Effect.gen(function* () {
		const tokenPayload = token ? verifyStorageObjectToken(token) : null;
		const videoId = Video.VideoId.make(videoIdParam);
		const hasKeyToken =
			tokenPayload?.videoId === videoIdParam && tokenPayload.key === key;
		const video = hasKeyToken
			? yield* getTokenVideo(videoId)
			: yield* getPolicyVideo(videoId);

		if (!key.startsWith(`${video.ownerId}/${video.id}/`)) {
			return yield* Effect.fail("not-found" as const);
		}
		if (isEditSourceObjectKey(key) && !hasKeyToken) {
			return yield* Effect.fail("not-found" as const);
		}
		if (
			isInternalRecordingKey(key) &&
			!hasKeyToken &&
			!(
				key === Video.getAudioLevelOutputKey(video) ||
				((video.source.type === "desktopMP4" ||
					video.source.type === "webMP4") &&
					[
						key === video.source.outputKey,
						key === video.source.thumbnailKey,
						key === video.source.previewKey,
					].some(Boolean))
			)
		) {
			return yield* Effect.fail("not-found" as const);
		}

		if (
			!hasKeyToken &&
			!internalDownload &&
			!key.startsWith(`${video.ownerId}/${video.id}/comments/`)
		) {
			const viewer = yield* Effect.serviceOption(CurrentUser);
			if (!Option.exists(viewer, (user) => user.id === video.ownerId)) {
				const locked = yield* Effect.tryPromise(() =>
					isVideoLockedByShareableLinkLimit(video.id),
				).pipe(
					Effect.tapError(Effect.logError),
					Effect.orElseSucceed(() => false),
				);
				if (locked) return yield* Effect.fail("not-found" as const);
			}
		}

		const [storage] = yield* Storage.getAccessForVideo(video);
		const internalRead =
			internalDownload || (hasKeyToken && tokenPayload?.internal === true);
		if (!internalRead && isPlayableMediaKey(key)) {
			const viewer = yield* Effect.serviceOption(CurrentUser);
			if (!Option.exists(viewer, (user) => user.id === video.ownerId)) {
				const decision = yield* Effect.gen(function* () {
					const freePlanVideo = yield* Effect.try(() => ({
						id: video.id,
						createdAt: video.createdAt,
						metadata: Option.getOrNull(video.metadata),
					}));
					const held = yield* Effect.tryPromise(() =>
						isVideoOverFreePlanDuration({
							...freePlanVideo,
							ownerId: video.ownerId,
							orgId: video.orgId,
						}),
					);
					if (held) return "held" as const;
					if (isWholeVideoKey(key))
						return yield* Effect.tryPromise(() =>
							firstViewDecision(freePlanVideo, key),
						);
					return (yield* isHeldByDeclaredLength(video, (objectKey) =>
						storage.getObject(objectKey).pipe(Effect.map(Option.getOrNull)),
					))
						? ("held" as const)
						: ("play" as const);
				}).pipe(Effect.orElseSucceed(() => "play" as const));
				if (decision !== "play")
					return yield* Effect.fail("not-found" as const);
			}
		}

		if (!("getObjectResponse" in storage)) {
			const url = downloadName
				? yield* storage.getSignedDownloadUrl(key, downloadName)
				: yield* storage.getSignedObjectUrl(key, playbackUrlValidity());
			return Response.redirect(url);
		}

		if (internalDownload) {
			if (!("getInternalDownload" in storage))
				return new Response("Unsupported storage", { status: 400 });
			const target = yield* storage.getInternalDownload(key, {
				objectIdentity:
					request.headers.get("x-cap-recording-object-identity") ??
					request.headers.get("if-match") ??
					undefined,
				signal: request.signal,
			});
			return Response.json(target, {
				headers: {
					"Cache-Control": "private, no-store",
					"Vercel-CDN-Cache-Control": "no-store",
					Vary: "x-cap-internal-download, x-media-server-secret",
				},
			});
		}

		const verificationRequested =
			request.headers.get("x-cap-recording-verification") === "1";
		const expectedIdentity = request.headers.get("if-match");
		const head =
			verificationRequested || request.method === "HEAD"
				? yield* storage.headObject(key)
				: undefined;
		const identity =
			verificationRequested && head
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
		if (request.method === "HEAD" && head) {
			const headers = new Headers(CACHE_CONTROL_HEADERS);
			if (identity) headers.set("ETag", identity);
			headers.set("Accept-Ranges", "bytes");
			if (head.ContentLength !== undefined)
				headers.set("Content-Length", String(head.ContentLength));
			setObjectContentHeaders(headers, head.ContentType);
			if (downloadName)
				headers.set(
					"Content-Disposition",
					attachmentContentDisposition(downloadName),
				);
			return new Response(null, { status: 200, headers });
		}
		const upstream = identity
			? yield* storage.getObjectResponse(key, request.headers.get("range"), {
					objectIdentity: identity,
					signal: request.signal,
				})
			: yield* storage.getObjectResponse(key, request.headers.get("range"), {
					signal: request.signal,
				});
		const headers = new Headers(CACHE_CONTROL_HEADERS);
		if (identity) headers.set("ETag", identity);
		setObjectContentHeaders(headers, upstream.headers.get("content-type"));
		if (downloadName)
			headers.set(
				"Content-Disposition",
				attachmentContentDisposition(downloadName),
			);
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

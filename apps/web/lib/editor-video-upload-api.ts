import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { CAP_BUNDLE_CONTENT_TYPE } from "@cap/editor-cap-bundle";
import { Database, Storage } from "@cap/web-backend";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Layer, Schedule, Schema } from "effect";
import {
	loadEligibleEditorVideo,
	requestMediaEditor,
	verifyOwnedEditorSession,
} from "./editor-session";
import {
	createEditorVideoLocation,
	EDITOR_VIDEO_UPLOAD_TTL_MS,
	editorVideoExtension,
	editorVideoUploadMatches,
	MAX_EDITOR_VIDEO_BYTES,
	MAX_EDITOR_VIDEO_COUNT,
	validateEditorVideoParts,
	validEditorVideoAsset,
} from "./editor-video-upload";
import { apiToHandler } from "./server";
import { decodeStorageVideo } from "./video-storage";

const SOURCE_URL_TTL_SECONDS = 20 * 60;
const VideoPart = Schema.Struct({
	partNumber: Schema.Number,
	etag: Schema.String,
	size: Schema.Number,
});
const VideoLocation = Schema.Struct({
	videoId: Video.VideoId,
	key: Schema.String,
	path: Schema.String,
});
const UploadRequest = Schema.extend(
	VideoLocation,
	Schema.Struct({ uploadId: Schema.String, subpath: Schema.String }),
);
const VideoResult = Schema.Struct({
	path: Schema.String,
	name: Schema.String,
	duration: Schema.Number,
	fps: Schema.Number,
	width: Schema.Number,
	height: Schema.Number,
	hasAudio: Schema.Boolean,
});
const CapResult = Schema.Struct({
	path: Schema.String,
	name: Schema.String,
	clipCount: Schema.Number,
});
const VideoJob = Schema.Struct({
	id: Schema.String,
	status: Schema.Literal("staging", "ready", "error", "canceled"),
	result: Schema.NullOr(Schema.Union(VideoResult, CapResult)),
	error: Schema.NullOr(Schema.String),
});

class Api extends HttpApi.make("WebEditorVideoUploadApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.post("prepare", "/api/editor/sessions/:id/video-assets")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setPayload(
					Schema.Struct({
						videoId: Video.VideoId,
						fileName: Schema.String,
						size: Schema.Number,
						contentType: Schema.String,
					}),
				)
				.addSuccess(
					Schema.Struct({
						key: Schema.String,
						path: Schema.String,
						uploadId: Schema.String,
						provider: Schema.Literal("s3", "googleDrive"),
					}),
				)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.get("start", "/api/editor/sessions/:id/video-assets")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setUrlParams(VideoLocation)
				.addSuccess(Schema.Struct({ id: Schema.String, status: Schema.String }))
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.get("job", "/api/editor/sessions/:id/video-assets/:jobId")
				.setPath(Schema.Struct({ id: Schema.String, jobId: Schema.String }))
				.setUrlParams(VideoLocation)
				.addSuccess(VideoJob)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.del(
				"cancelJob",
				"/api/editor/sessions/:id/video-assets/:jobId",
			)
				.setPath(Schema.Struct({ id: Schema.String, jobId: Schema.String }))
				.setUrlParams(VideoLocation)
				.addSuccess(Schema.Struct({ success: Schema.Boolean }))
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.post(
				"part",
				"/api/editor/sessions/:id/video-assets/presign-part",
			)
				.setPath(Schema.Struct({ id: Schema.String }))
				.setPayload(
					Schema.extend(
						UploadRequest,
						Schema.Struct({ partNumber: Schema.Number }),
					),
				)
				.addSuccess(
					Schema.Struct({
						presignedUrl: Schema.String,
						provider: Schema.Literal("s3", "googleDrive"),
					}),
				)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.post(
				"complete",
				"/api/editor/sessions/:id/video-assets/complete",
			)
				.setPath(Schema.Struct({ id: Schema.String }))
				.setPayload(
					Schema.extend(
						UploadRequest,
						Schema.Struct({ parts: Schema.Array(VideoPart) }),
					),
				)
				.addSuccess(Schema.Struct({ success: Schema.Boolean }))
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.post(
				"abort",
				"/api/editor/sessions/:id/video-assets/abort",
			)
				.setPath(Schema.Struct({ id: Schema.String }))
				.setPayload(UploadRequest)
				.addSuccess(Schema.Struct({ success: Schema.Boolean }))
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.middleware(HttpAuthMiddleware),
		),
) {}

type DbVideo = typeof videos.$inferSelect;
type SavedVideo = NonNullable<
	VideoMetadata["webEditorVideos"]
>["items"][number];

function storageBinding(video: DbVideo) {
	return {
		bucketId: video.bucket,
		storageIntegrationId: video.storageIntegrationId,
	};
}

function savedVideo(video: DbVideo, key: string, path: string) {
	const asset = video.metadata?.webEditorVideos?.items.find(
		(item) => item.key === key && item.path === path,
	);
	return asset && validEditorVideoAsset(asset, video.ownerId, video.id)
		? asset
		: null;
}

function affectedOne(value: unknown) {
	const result = Array.isArray(value) ? value[0] : value;
	return (
		typeof result === "object" &&
		result !== null &&
		"affectedRows" in result &&
		result.affectedRows === 1
	);
}

const getBucket = Effect.fn("WebEditorVideoUpload.getBucket")(function* (
	video: DbVideo,
) {
	const [bucket] = yield* Storage.getAccessForVideo(decodeStorageVideo(video), {
		resolvePublishedOutput: false,
	}).pipe(
		Effect.catchTag("StorageError", () =>
			Effect.fail(new HttpApiError.ServiceUnavailable()),
		),
	);
	return bucket;
});

const readUpload = Effect.fn("WebEditorVideoUpload.readUpload")(function* (
	videoId: Video.VideoId,
	sessionId: string,
	uploadId: string,
	key: string,
	path: string,
	allowExpired = false,
) {
	const video = yield* loadEligibleEditorVideo(videoId);
	yield* verifyOwnedEditorSession(videoId, sessionId);
	const pending = video.metadata?.webEditorVideoUpload;
	if (
		!pending ||
		!editorVideoUploadMatches(
			pending,
			{
				videoId: video.id,
				ownerId: video.ownerId,
				sessionId,
				uploadId,
				key,
				path,
				...storageBinding(video),
			},
			allowExpired,
		)
	) {
		return yield* new HttpApiError.BadRequest();
	}
	const bucket = yield* getBucket(video);
	if (pending.provider !== bucket.provider) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	return { video, pending, bucket };
});

const startStaging = Effect.fn("WebEditorVideoUpload.startStaging")(function* (
	video: DbVideo,
	sessionId: string,
	asset: SavedVideo,
) {
	const sessionPath = yield* verifyOwnedEditorSession(video.id, sessionId);
	const bucket = yield* getBucket(video);
	const head = yield* bucket
		.headObject(asset.key)
		.pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
	const identity = getRecordingObjectIdentity(
		head,
		asset.objectIdentity ?? undefined,
	);
	if (
		head.ContentLength !== asset.size ||
		!identity ||
		(asset.objectIdentity && asset.objectIdentity !== identity)
	) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const url = yield* bucket
		.getInternalSignedObjectUrl(asset.key, {
			expiresIn: SOURCE_URL_TTL_SECONDS,
		})
		.pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
	const sourcePath =
		asset.contentType === CAP_BUNDLE_CONTENT_TYPE
			? `${sessionPath}/cap-assets`
			: `${sessionPath}/video-assets`;
	const response = yield* requestMediaEditor(sourcePath, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			path: asset.path,
			name: asset.name,
			url,
			size: asset.size,
			contentType: asset.contentType,
			objectIdentity: identity,
		}),
	});
	if (response.status === 404) return yield* new HttpApiError.NotFound();
	if (!response.ok) return yield* new HttpApiError.ServiceUnavailable();
	const value: unknown = yield* Effect.tryPromise({
		try: () => response.json(),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	if (
		typeof value !== "object" ||
		value === null ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!("status" in value) ||
		value.status !== "staging"
	) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	return { id: value.id, status: value.status };
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("prepare", ({ path, payload }) =>
					Effect.gen(function* () {
						const extension = editorVideoExtension(
							payload.fileName,
							payload.size,
							payload.contentType,
						);
						if (!extension) return yield* new HttpApiError.BadRequest();
						const video = yield* loadEligibleEditorVideo(payload.videoId);
						yield* verifyOwnedEditorSession(payload.videoId, path.id);
						const saved = video.metadata?.webEditorVideos?.items ?? [];
						if (
							video.metadata?.webEditorVideos?.version !== undefined &&
							video.metadata.webEditorVideos.version !== 1
						) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						if (
							!Array.isArray(saved) ||
							saved.length >= MAX_EDITOR_VIDEO_COUNT ||
							saved.some(
								(asset) =>
									!validEditorVideoAsset(asset, video.ownerId, video.id),
							) ||
							saved.reduce((total, asset) => total + asset.size, payload.size) >
								MAX_EDITOR_VIDEO_BYTES
						) {
							return yield* new HttpApiError.BadRequest();
						}
						const old = video.metadata?.webEditorVideoUpload;
						const oldExpires = old ? Date.parse(old.expiresAt) : 0;
						if (old && !Number.isFinite(oldExpires)) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						if (old && oldExpires > Date.now()) {
							return yield* new HttpApiError.Conflict();
						}
						if (
							old &&
							!editorVideoUploadMatches(
								old,
								{
									videoId: video.id,
									ownerId: video.ownerId,
									sessionId: old.sessionId,
									uploadId: old.uploadId,
									key: old.key,
									path: old.path,
									...storageBinding(video),
								},
								true,
							)
						) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						const bucket = yield* getBucket(video);
						if (old && old.provider !== bucket.provider) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						const location = createEditorVideoLocation(
							video.ownerId,
							video.id,
							extension,
						);
						const created = yield* bucket.multipart
							.create(location.key, {
								ContentType: payload.contentType,
								Metadata: {
									source:
										extension === "capbundle"
											? "cap-editor-cap-import"
											: "cap-editor-video-import",
								},
							})
							.pipe(
								Effect.catchTag("StorageError", () =>
									Effect.fail(new HttpApiError.ServiceUnavailable()),
								),
							);
						if (!created.UploadId) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						const uploadId = created.UploadId;
						const pending: NonNullable<VideoMetadata["webEditorVideoUpload"]> =
							{
								version: 1,
								sessionId: path.id,
								key: location.key,
								path: location.path,
								fileName: payload.fileName,
								size: payload.size,
								contentType: payload.contentType,
								uploadId,
								provider: bucket.provider,
								...storageBinding(video),
								expiresAt: new Date(
									Date.now() + EDITOR_VIDEO_UPLOAD_TTL_MS,
								).toISOString(),
							};
						const database = yield* Database;
						const serialized = JSON.stringify(pending);
						const now = new Date().toISOString();
						const updated: unknown = yield* database
							.use((client) =>
								client
									.update(videos)
									.set({
										metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.webEditorVideoUpload', CAST(${serialized} AS JSON))`,
									})
									.where(
										and(
											eq(videos.id, video.id),
											eq(videos.ownerId, video.ownerId),
											sql`(JSON_EXTRACT(${videos.metadata}, '$.webEditorVideoUpload') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.webEditorVideoUpload.expiresAt')) <= ${now})`,
										),
									),
							)
							.pipe(
								Effect.catchAll(() =>
									bucket.multipart.abort(location.key, uploadId).pipe(
										Effect.catchAll(() => Effect.void),
										Effect.flatMap(() =>
											Effect.fail(new HttpApiError.InternalServerError()),
										),
									),
								),
							);
						if (!affectedOne(updated)) {
							yield* bucket.multipart
								.abort(location.key, uploadId)
								.pipe(Effect.catchAll(() => Effect.void));
							return yield* new HttpApiError.Conflict();
						}
						if (old) {
							yield* bucket.multipart
								.abort(old.key, old.uploadId)
								.pipe(Effect.catchAll(() => Effect.void));
						}
						return {
							...location,
							uploadId,
							provider: bucket.provider,
						};
					}),
				)
				.handle("start", ({ path, urlParams }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(urlParams.videoId);
						const asset = savedVideo(video, urlParams.key, urlParams.path);
						if (!asset) return yield* new HttpApiError.NotFound();
						return yield* startStaging(video, path.id, asset);
					}),
				)
				.handle("job", ({ path, urlParams }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(urlParams.videoId);
						const asset = savedVideo(video, urlParams.key, urlParams.path);
						if (!asset) return yield* new HttpApiError.NotFound();
						const sessionPath = yield* verifyOwnedEditorSession(
							urlParams.videoId,
							path.id,
						);
						const sourcePath =
							asset.contentType === CAP_BUNDLE_CONTENT_TYPE
								? `${sessionPath}/cap-assets`
								: `${sessionPath}/video-assets`;
						const response = yield* requestMediaEditor(
							`${sourcePath}/${encodeURIComponent(path.jobId)}`,
						);
						if (response.status === 404)
							return yield* new HttpApiError.NotFound();
						if (!response.ok)
							return yield* new HttpApiError.ServiceUnavailable();
						const value: unknown = yield* Effect.tryPromise({
							try: () => response.json(),
							catch: () => new HttpApiError.ServiceUnavailable(),
						});
						if (
							typeof value !== "object" ||
							value === null ||
							!("id" in value) ||
							value.id !== path.jobId ||
							!("status" in value) ||
							!["staging", "ready", "error", "canceled"].includes(
								String(value.status),
							) ||
							!("result" in value) ||
							!("error" in value) ||
							(value.result !== null &&
								(typeof value.result !== "object" ||
									!("path" in value.result) ||
									value.result.path !== asset.path))
						) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						return value as Schema.Schema.Type<typeof VideoJob>;
					}),
				)
				.handle("cancelJob", ({ path, urlParams }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(urlParams.videoId);
						const asset = savedVideo(video, urlParams.key, urlParams.path);
						if (!asset) return yield* new HttpApiError.NotFound();
						const sessionPath = yield* verifyOwnedEditorSession(
							urlParams.videoId,
							path.id,
						);
						const sourcePath =
							asset.contentType === CAP_BUNDLE_CONTENT_TYPE
								? `${sessionPath}/cap-assets`
								: `${sessionPath}/video-assets`;
						const response = yield* requestMediaEditor(
							`${sourcePath}/${encodeURIComponent(path.jobId)}`,
							{ method: "DELETE" },
						);
						if (response.status === 404)
							return yield* new HttpApiError.NotFound();
						if (response.status !== 204)
							return yield* new HttpApiError.ServiceUnavailable();
						return { success: true };
					}),
				)
				.handle("part", ({ path, payload }) =>
					Effect.gen(function* () {
						if (payload.subpath !== payload.key)
							return yield* new HttpApiError.BadRequest();
						const { pending, bucket } = yield* readUpload(
							payload.videoId,
							path.id,
							payload.uploadId,
							payload.key,
							payload.path,
						);
						if (
							!Number.isSafeInteger(payload.partNumber) ||
							payload.partNumber < 1 ||
							payload.partNumber >
								Math.min(10_000, Math.ceil(pending.size / (5 * 1024 * 1024)))
						) {
							return yield* new HttpApiError.BadRequest();
						}
						const presignedUrl = yield* bucket.multipart
							.getPresignedUploadPartUrl(
								pending.key,
								pending.uploadId,
								payload.partNumber,
							)
							.pipe(
								Effect.catchTag("StorageError", () =>
									Effect.fail(new HttpApiError.ServiceUnavailable()),
								),
							);
						return { presignedUrl, provider: bucket.provider };
					}),
				)
				.handle("complete", ({ path, payload }) =>
					Effect.gen(function* () {
						if (payload.subpath !== payload.key)
							return yield* new HttpApiError.BadRequest();
						const video = yield* loadEligibleEditorVideo(payload.videoId);
						yield* verifyOwnedEditorSession(payload.videoId, path.id);
						if (savedVideo(video, payload.key, payload.path)) {
							return { success: true };
						}
						const { pending, bucket } = yield* readUpload(
							payload.videoId,
							path.id,
							payload.uploadId,
							payload.key,
							payload.path,
						);
						if (!validateEditorVideoParts(payload.parts, pending.size)) {
							return yield* new HttpApiError.BadRequest();
						}
						const existing =
							bucket.provider === "s3"
								? yield* bucket
										.headObject(pending.key)
										.pipe(
											Effect.catchTag("StorageError", () =>
												Effect.succeed(null),
											),
										)
								: null;
						if (!existing || existing.ContentLength !== pending.size) {
							yield* bucket.multipart
								.complete(pending.key, pending.uploadId, {
									MultipartUpload: {
										Parts: payload.parts.map((part) => ({
											PartNumber: part.partNumber,
											ETag: part.etag,
										})),
									},
									...(bucket.provider === "googleDrive"
										? { MpuObjectSize: pending.size }
										: {}),
								})
								.pipe(
									Effect.catchTag("StorageError", () =>
										Effect.fail(new HttpApiError.ServiceUnavailable()),
									),
								);
						}
						const head = yield* bucket.headObject(pending.key).pipe(
							Effect.retry({
								times: 3,
								schedule: Schedule.exponential("50 millis"),
							}),
							Effect.catchTag("StorageError", () =>
								Effect.fail(new HttpApiError.ServiceUnavailable()),
							),
						);
						const identity = getRecordingObjectIdentity(head);
						if (head.ContentLength !== pending.size || !identity) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						const saved = video.metadata?.webEditorVideos?.items ?? [];
						const asset = JSON.stringify({
							key: pending.key,
							path: pending.path,
							name: pending.fileName.replace(/\.[^.]+$/, ""),
							contentType: pending.contentType,
							size: pending.size,
							objectIdentity: identity,
						});
						const database = yield* Database;
						const updated: unknown = yield* database
							.use((client) =>
								client
									.update(videos)
									.set({
										metadata: sql`JSON_SET(JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.webEditorVideoUpload'), '$.webEditorVideos', JSON_OBJECT('version', 1, 'items', JSON_ARRAY_APPEND(COALESCE(JSON_EXTRACT(${videos.metadata}, '$.webEditorVideos.items'), JSON_ARRAY()), '$', CAST(${asset} AS JSON))))`,
									})
									.where(
										and(
											eq(videos.id, video.id),
											eq(videos.ownerId, video.ownerId),
											sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.webEditorVideoUpload.uploadId')) = ${pending.uploadId}`,
											sql`COALESCE(JSON_LENGTH(JSON_EXTRACT(${videos.metadata}, '$.webEditorVideos.items')), 0) = ${saved.length}`,
										),
									),
							)
							.pipe(
								Effect.catchTag("DatabaseError", () =>
									Effect.fail(new HttpApiError.InternalServerError()),
								),
							);
						if (!affectedOne(updated)) {
							return yield* new HttpApiError.Conflict();
						}
						return { success: true };
					}),
				)
				.handle("abort", ({ path, payload }) =>
					Effect.gen(function* () {
						if (payload.subpath !== payload.key)
							return yield* new HttpApiError.BadRequest();
						const video = yield* loadEligibleEditorVideo(payload.videoId);
						yield* verifyOwnedEditorSession(payload.videoId, path.id);
						if (savedVideo(video, payload.key, payload.path)) {
							return { success: true };
						}
						const { pending, bucket } = yield* readUpload(
							payload.videoId,
							path.id,
							payload.uploadId,
							payload.key,
							payload.path,
							true,
						);
						yield* bucket.multipart
							.abort(pending.key, pending.uploadId)
							.pipe(
								Effect.catchTag("StorageError", () =>
									Effect.fail(new HttpApiError.ServiceUnavailable()),
								),
							);
						const database = yield* Database;
						yield* database
							.use((client) =>
								client
									.update(videos)
									.set({
										metadata: sql`JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.webEditorVideoUpload')`,
									})
									.where(
										and(
											eq(videos.id, video.id),
											eq(videos.ownerId, video.ownerId),
											sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.webEditorVideoUpload.uploadId')) = ${pending.uploadId}`,
										),
									),
							)
							.pipe(
								Effect.catchTag("DatabaseError", () =>
									Effect.fail(new HttpApiError.ServiceUnavailable()),
								),
							);
						return { success: true };
					}),
				),
		),
	),
);

export const handler = apiToHandler(ApiLive);

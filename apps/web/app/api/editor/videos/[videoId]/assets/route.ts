import { randomUUID } from "node:crypto";
import { videos } from "@cap/database/schema";
import { Database, Storage } from "@cap/web-backend";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import {
	CurrentUser,
	HttpAuthMiddleware,
	Storage as StorageDomain,
	Video,
} from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import {
	editorAssetExtension,
	editorAssetKey,
	validEditorAssetMeasurement,
} from "@/lib/editor-assets";
import { videoMetadataObject } from "@/lib/editor-metadata-sql";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";

const MAX_ASSETS = 100;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const AUDIO_ASSET_PATH =
	/^assets\/audio\/import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(ogg|m4a|mp3|wav|aac|flac)$/;
const IMAGE_ASSET_PATH =
	/^content\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|tiff)$/;

const AssetFile = Schema.Struct({
	kind: Schema.Literal("audio", "image"),
	fileName: Schema.String,
	size: Schema.Number,
	contentType: Schema.String,
});

class Api extends HttpApi.make("WebEditorAssetsApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get(
				"desktopBackground",
				"/api/editor/videos/:videoId/assets",
			)
				.setPath(Schema.Struct({ videoId: Video.VideoId }))
				.addSuccess(Schema.Struct({ path: Schema.NullOr(Schema.String) }))
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.post("prepare", "/api/editor/videos/:videoId/assets")
				.setPath(Schema.Struct({ videoId: Video.VideoId }))
				.setPayload(AssetFile)
				.addSuccess(
					Schema.Struct({
						key: Schema.String,
						path: Schema.String,
						upload: StorageDomain.UploadTarget,
					}),
				)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.put("complete", "/api/editor/videos/:videoId/assets")
				.setPath(Schema.Struct({ videoId: Video.VideoId }))
				.setPayload(
					Schema.extend(
						AssetFile,
						Schema.Struct({
							key: Schema.String,
							path: Schema.String,
							duration: Schema.optional(Schema.Number),
							width: Schema.optional(Schema.Number),
							height: Schema.optional(Schema.Number),
						}),
					),
				)
				.addSuccess(
					Schema.Union(
						Schema.Struct({
							path: Schema.String,
							name: Schema.String,
							duration: Schema.Number,
						}),
						Schema.Struct({
							path: Schema.String,
							name: Schema.String,
							width: Schema.Number,
							height: Schema.Number,
						}),
					),
				)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

function affectedOne(value: unknown) {
	const result = Array.isArray(value) ? value[0] : value;
	return (
		typeof result === "object" &&
		result !== null &&
		"affectedRows" in result &&
		result.affectedRows === 1
	);
}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("desktopBackground", ({ path }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(path.videoId);
						const saved = video.metadata?.webEditorAssets?.items ?? [];
						const imported = saved.findLast(
							(asset) =>
								asset.kind === "image" &&
								asset.name === "current-desktop-background" &&
								IMAGE_ASSET_PATH.test(asset.path) &&
								asset.key ===
									editorAssetKey(video.ownerId, video.id, "image", asset.path),
						);
						return { path: imported?.path ?? null };
					}),
				)
				.handle("prepare", ({ path, payload }) =>
					Effect.gen(function* () {
						const extension = editorAssetExtension(
							payload.kind,
							payload.fileName,
							payload.size,
							payload.contentType,
						);
						if (!extension) return yield* new HttpApiError.BadRequest();
						const video = yield* loadEligibleEditorVideo(path.videoId);
						const saved = video.metadata?.webEditorAssets?.items ?? [];
						if (
							saved.length >= MAX_ASSETS ||
							saved.reduce((bytes, asset) => bytes + asset.size, payload.size) >
								MAX_TOTAL_BYTES
						) {
							return yield* new HttpApiError.BadRequest();
						}
						const id = randomUUID();
						const generatedPath =
							payload.kind === "audio"
								? `assets/audio/import-${id}.${extension}`
								: `content/images/${id}.${extension}`;
						const key = editorAssetKey(
							video.ownerId,
							video.id,
							payload.kind,
							generatedPath,
						);
						const upload = yield* Storage.createUploadTargetForVideo(
							decodeStorageVideo(video),
							key,
							{
								contentType: payload.contentType,
								contentLength: payload.size,
								method: "put",
								videoTitle: video.name ?? undefined,
							},
						).pipe(
							Effect.catchTag("StorageError", () =>
								Effect.fail(new HttpApiError.ServiceUnavailable()),
							),
						);
						return { key, path: generatedPath, upload };
					}),
				)
				.handle("complete", ({ path, payload }) =>
					Effect.gen(function* () {
						const extension = editorAssetExtension(
							payload.kind,
							payload.fileName,
							payload.size,
							payload.contentType,
						);
						const match =
							payload.kind === "audio"
								? AUDIO_ASSET_PATH.exec(payload.path)
								: IMAGE_ASSET_PATH.exec(payload.path);
						const measurement = validEditorAssetMeasurement(payload.kind, {
							duration: payload.duration,
							width: payload.width,
							height: payload.height,
						});
						if (
							!extension ||
							!match ||
							match[1] !== extension ||
							!measurement
						) {
							return yield* new HttpApiError.BadRequest();
						}
						const video = yield* loadEligibleEditorVideo(path.videoId);
						if (
							payload.key !==
							editorAssetKey(
								video.ownerId,
								video.id,
								payload.kind,
								payload.path,
							)
						) {
							return yield* new HttpApiError.BadRequest();
						}
						const saved = video.metadata?.webEditorAssets?.items ?? [];
						if (
							saved.length >= MAX_ASSETS ||
							saved.reduce((bytes, asset) => bytes + asset.size, payload.size) >
								MAX_TOTAL_BYTES ||
							saved.some((asset) => asset.key === payload.key)
						) {
							return yield* new HttpApiError.BadRequest();
						}
						const [bucket] = yield* Storage.getAccessForVideo(
							decodeStorageVideo(video),
							{ resolvePublishedOutput: false },
						).pipe(
							Effect.catchTag("StorageError", () =>
								Effect.fail(new HttpApiError.ServiceUnavailable()),
							),
						);
						const head = yield* bucket
							.headObject(payload.key)
							.pipe(
								Effect.catchTag("StorageError", () =>
									Effect.fail(new HttpApiError.ServiceUnavailable()),
								),
							);
						const identity = getRecordingObjectIdentity(head);
						if (head.ContentLength !== payload.size || !identity) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						const name =
							payload.fileName.replace(/\.[^.]+$/, "").trim() ||
							(payload.kind === "audio" ? "Audio" : "Image");
						const asset = JSON.stringify({
							kind: payload.kind,
							key: payload.key,
							path: payload.path,
							name,
							contentType: payload.contentType,
							size: payload.size,
							objectIdentity: identity,
						});
						const database = yield* Database;
						const user = yield* CurrentUser;
						const updated: unknown = yield* database
							.use((client) =>
								client
									.update(videos)
									.set({
										metadata: sql`JSON_SET(${videoMetadataObject()}, '$.webEditorAssets', JSON_OBJECT('version', 1, 'items', JSON_ARRAY_APPEND(COALESCE(JSON_EXTRACT(${videos.metadata}, '$.webEditorAssets.items'), JSON_ARRAY()), '$', CAST(${asset} AS JSON))))`,
									})
									.where(
										and(
											eq(videos.id, video.id),
											eq(videos.ownerId, user.id),
											sql`COALESCE(JSON_LENGTH(JSON_EXTRACT(${videos.metadata}, '$.webEditorAssets.items')), 0) = ${saved.length}`,
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
						return "duration" in measurement
							? { path: payload.path, name, duration: measurement.duration }
							: {
									path: payload.path,
									name,
									width: measurement.width,
									height: measurement.height,
								};
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;
export const PUT = handler;

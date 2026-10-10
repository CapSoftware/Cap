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
	loadEligibleEditorVideo,
	requestMediaEditor,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_ASSETS = 100;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const SOURCE_URL_TTL_SECONDS = 20 * 60;
const AUDIO_CONTENT_TYPES: Record<string, string> = {
	ogg: "audio/ogg",
	m4a: "audio/mp4",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	aac: "audio/aac",
	flac: "audio/flac",
};
const IMAGE_CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tiff: "image/tiff",
};
const AUDIO_ASSET_PATH =
	/^assets\/audio\/import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(ogg|m4a|mp3|wav|aac|flac)$/;
const IMAGE_ASSET_PATH =
	/^content\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|tiff)$/;
type AssetKind = "audio" | "image";

function assetExtension(
	kind: AssetKind,
	name: string,
	size: number,
	contentType: string,
) {
	if (
		name.length < 1 ||
		name.length > 100 ||
		name.split("").some((character) => {
			const code = character.charCodeAt(0);
			return (
				code < 32 || code === 127 || character === "/" || character === "\\"
			);
		}) ||
		!Number.isSafeInteger(size) ||
		size < 1 ||
		size > (kind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES)
	) {
		return null;
	}
	const match = /\.([a-z0-9]+)$/i.exec(name);
	const extension = match?.[1]?.toLowerCase() ?? "";
	const canonical =
		kind === "image" && extension === "jpeg"
			? "jpg"
			: kind === "image" && (extension === "tif" || extension === "tiff")
				? "tiff"
				: extension;
	const types = kind === "audio" ? AUDIO_CONTENT_TYPES : IMAGE_CONTENT_TYPES;
	return types[canonical] === contentType ? canonical : null;
}

function assetPath(kind: AssetKind, extension: string) {
	const id = randomUUID();
	return kind === "audio"
		? `assets/audio/import-${id}.${extension}`
		: `content/images/${id}.${extension}`;
}

function assetKey(
	ownerId: string,
	videoId: string,
	kind: AssetKind,
	path: string,
) {
	return kind === "audio"
		? `${ownerId}/${videoId}/editor-assets/${path.slice("assets/audio/".length)}`
		: `${ownerId}/${videoId}/editor-assets/images/${path.slice("content/images/".length)}`;
}

type ImportedAsset =
	| { path: string; name: string; duration: number }
	| { path: string; name: string; width: number; height: number };

function validImportedAsset(
	kind: AssetKind,
	value: unknown,
	path: string,
): value is ImportedAsset {
	if (
		typeof value !== "object" ||
		value === null ||
		!("path" in value) ||
		value.path !== path ||
		!("name" in value) ||
		typeof value.name !== "string" ||
		value.name.length < 1 ||
		value.name.length > 100
	) {
		return false;
	}
	if (kind === "audio") {
		return (
			"duration" in value &&
			typeof value.duration === "number" &&
			Number.isFinite(value.duration) &&
			value.duration > 0
		);
	}
	return (
		"width" in value &&
		"height" in value &&
		typeof value.width === "number" &&
		typeof value.height === "number" &&
		Number.isInteger(value.width) &&
		Number.isInteger(value.height) &&
		value.width > 0 &&
		value.height > 0 &&
		value.width <= 32_768 &&
		value.height <= 32_768 &&
		value.width * value.height <= 16_777_216
	);
}

const assetPayload = Schema.Struct({
	kind: Schema.Literal("audio", "image"),
	videoId: Video.VideoId,
	fileName: Schema.String,
	size: Schema.Number,
	contentType: Schema.String,
});

class Api extends HttpApi.make("WebEditorAssetsApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get(
				"desktopBackground",
				"/api/editor/sessions/:id/assets",
			)
				.setPath(Schema.Struct({ id: Schema.String }))
				.setUrlParams(Schema.Struct({ videoId: Video.VideoId }))
				.addSuccess(Schema.Struct({ path: Schema.NullOr(Schema.String) }))
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.post("prepare", "/api/editor/sessions/:id/assets")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setPayload(assetPayload)
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
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.put("complete", "/api/editor/sessions/:id/assets")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setPayload(
					Schema.extend(
						assetPayload,
						Schema.Struct({ key: Schema.String, path: Schema.String }),
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
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("desktopBackground", ({ path, urlParams }) =>
					Effect.gen(function* () {
						yield* verifyOwnedEditorSession(urlParams.videoId, path.id);
						const video = yield* loadEligibleEditorVideo(urlParams.videoId);
						const saved = video.metadata?.webEditorAssets?.items ?? [];
						const imported = saved.findLast(
							(asset) =>
								asset.kind === "image" &&
								asset.name === "current-desktop-background" &&
								IMAGE_ASSET_PATH.test(asset.path) &&
								asset.key ===
									assetKey(video.ownerId, video.id, "image", asset.path),
						);
						return { path: imported?.path ?? null };
					}),
				)
				.handle("prepare", ({ path, payload }) =>
					Effect.gen(function* () {
						const extension = assetExtension(
							payload.kind,
							payload.fileName,
							payload.size,
							payload.contentType,
						);
						if (!extension) return yield* new HttpApiError.BadRequest();
						const video = yield* loadEligibleEditorVideo(payload.videoId);
						yield* verifyOwnedEditorSession(payload.videoId, path.id);
						const saved = video.metadata?.webEditorAssets?.items ?? [];
						if (
							saved.length >= MAX_ASSETS ||
							saved.reduce((bytes, asset) => bytes + asset.size, payload.size) >
								MAX_TOTAL_BYTES
						) {
							return yield* new HttpApiError.BadRequest();
						}
						const generatedPath = assetPath(payload.kind, extension);
						const key = assetKey(
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
						const extension = assetExtension(
							payload.kind,
							payload.fileName,
							payload.size,
							payload.contentType,
						);
						const match =
							payload.kind === "audio"
								? AUDIO_ASSET_PATH.exec(payload.path)
								: IMAGE_ASSET_PATH.exec(payload.path);
						if (!extension || !match || match[1] !== extension) {
							return yield* new HttpApiError.BadRequest();
						}
						const video = yield* loadEligibleEditorVideo(payload.videoId);
						const sessionPath = yield* verifyOwnedEditorSession(
							payload.videoId,
							path.id,
						);
						if (
							payload.key !==
							assetKey(video.ownerId, video.id, payload.kind, payload.path)
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
						const url = yield* bucket
							.getInternalSignedObjectUrl(payload.key, {
								expiresIn: SOURCE_URL_TTL_SECONDS,
							})
							.pipe(
								Effect.catchTag("StorageError", () =>
									Effect.fail(new HttpApiError.ServiceUnavailable()),
								),
							);
						const native = yield* requestMediaEditor(
							`${sessionPath}/${payload.kind}-assets`,
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									path: payload.path,
									name: payload.fileName.replace(/\.[^.]+$/, ""),
									url,
									size: payload.size,
									contentType: payload.contentType,
									objectIdentity: identity,
								}),
							},
							150_000,
						);
						if (!native.ok) return yield* new HttpApiError.ServiceUnavailable();
						const imported: unknown = yield* Effect.tryPromise({
							try: () => native.json(),
							catch: () => new HttpApiError.ServiceUnavailable(),
						});
						if (!validImportedAsset(payload.kind, imported, payload.path)) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						const asset = JSON.stringify({
							kind: payload.kind,
							key: payload.key,
							path: payload.path,
							name: imported.name,
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
										metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.webEditorAssets', JSON_OBJECT('version', 1, 'items', JSON_ARRAY_APPEND(COALESCE(JSON_EXTRACT(${videos.metadata}, '$.webEditorAssets.items'), JSON_ARRAY()), '$', CAST(${asset} AS JSON))))`,
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
						const result = Array.isArray(updated) ? updated[0] : updated;
						if (
							typeof result !== "object" ||
							result === null ||
							!("affectedRows" in result) ||
							result.affectedRows !== 1
						) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						return "duration" in imported
							? {
									path: imported.path,
									name: imported.name,
									duration: imported.duration,
								}
							: {
									path: imported.path,
									name: imported.name,
									width: imported.width,
									height: imported.height,
								};
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
export const PUT = handler;
export const GET = handler;

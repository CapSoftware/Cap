import { videos } from "@cap/database/schema";
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
import { Effect, Layer, Schema } from "effect";
import { stripEditorCaptionContent } from "@/lib/editor-caption-access";
import {
	appendWebEditorClipToConfig,
	MAX_WEB_EDITOR_CLIPS,
	validWebEditorClip,
} from "@/lib/editor-clips";
import {
	appendWebEditorImport,
	nextEditorRecordingSegmentIndex,
	normalizeWebEditorImportOrder,
} from "@/lib/editor-imports";
import { videoMetadataObject } from "@/lib/editor-metadata-sql";
import {
	decodeWebEditorProject,
	encodeWebEditorProject,
} from "@/lib/editor-project-storage";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { validEditorVideoAsset } from "@/lib/editor-video-upload";
import { resolveEditorSourceDuration } from "@/lib/measure-editor-source-duration";
import { apiToHandler } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

class Api extends HttpApi.make("WebEditorClipsApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("append", "/api/editor/videos/:videoId/clips")
			.setPath(Schema.Struct({ videoId: Video.VideoId }))
			.setPayload(
				Schema.Struct({
					path: Schema.String,
					duration: Schema.Number,
					fps: Schema.Number,
					hasAudio: Schema.Boolean,
					camera: Schema.optional(
						Schema.Struct({
							path: Schema.String,
							fps: Schema.Number,
							offsetMs: Schema.Number,
						}),
					),
					projectConfig: Schema.optional(Schema.Unknown),
				}),
			)
			.addSuccess(Schema.Struct({ count: Schema.Number }))
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.Conflict)
			.addError(HttpApiError.ServiceUnavailable)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function affectedOne(value: unknown) {
	const result = Array.isArray(value) ? value[0] : value;
	return asRecord(result) && result.affectedRows === 1;
}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("append", ({ path, payload }) =>
				Effect.gen(function* () {
					const video = yield* loadEligibleEditorVideo(path.videoId);
					const assets = video.metadata?.webEditorVideos?.items ?? [];
					const clip = {
						displayPath: payload.path,
						duration: payload.duration,
						fps: payload.fps,
						hasAudio: payload.hasAudio,
						...(payload.camera
							? {
									cameraPath: payload.camera.path,
									cameraFps: payload.camera.fps,
									cameraOffsetMs: payload.camera.offsetMs,
								}
							: {}),
					};
					if (
						video.metadata?.webEditorVideos?.version !== 1 ||
						!validWebEditorClip(clip, assets, video.ownerId, video.id)
					) {
						return yield* new HttpApiError.BadRequest();
					}
					const saved = video.metadata?.webEditorClips?.items ?? [];
					if (
						(video.metadata?.webEditorClips &&
							video.metadata.webEditorClips.version !== 1) ||
						!Array.isArray(saved) ||
						saved.length > MAX_WEB_EDITOR_CLIPS ||
						saved.some(
							(item) =>
								!validWebEditorClip(item, assets, video.ownerId, video.id),
						)
					) {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					const priorImports = video.metadata?.webEditorImports;
					const order = normalizeWebEditorImportOrder(
						priorImports,
						saved,
						assets,
						video.ownerId,
						video.id,
					);
					if (!order) return yield* new HttpApiError.ServiceUnavailable();
					const existing = saved.find(
						(item) => item.displayPath === payload.path,
					);
					if (existing) {
						if (
							existing.cameraPath !== clip.cameraPath ||
							existing.cameraOffsetMs !== clip.cameraOffsetMs
						)
							return yield* new HttpApiError.Conflict();
						return { count: 1 };
					}
					if (saved.length >= MAX_WEB_EDITOR_CLIPS) {
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
					for (const mediaPath of [payload.path, payload.camera?.path]) {
						if (!mediaPath) continue;
						const asset = assets.find((item) => item.path === mediaPath);
						if (
							!asset ||
							!validEditorVideoAsset(asset, video.ownerId, video.id)
						)
							return yield* new HttpApiError.NotFound();
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
							(asset.objectIdentity !== null &&
								identity !== asset.objectIdentity)
						) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
					}
					const priorProject = video.metadata?.webEditorProject;
					// A recording opened but never edited has no stored project: the
					// editor sends the configuration it is showing to extend instead.
					const priorConfig = priorProject
						? decodeWebEditorProject(priorProject)
						: asRecord(payload.projectConfig)
							? video.captionsEnabled
								? payload.projectConfig
								: stripEditorCaptionContent(payload.projectConfig)
							: null;
					if (!priorConfig && priorProject)
						return yield* new HttpApiError.ServiceUnavailable();
					if (!priorConfig) return yield* new HttpApiError.Conflict();
					const nextConfig = appendWebEditorClipToConfig(
						priorConfig,
						nextEditorRecordingSegmentIndex(order),
						yield* resolveEditorSourceDuration(video),
						clip.duration,
					);
					if (!nextConfig) return yield* new HttpApiError.Conflict();
					const nextOrder = appendWebEditorImport(order, {
						kind: "clip",
						path: payload.path,
					});
					if (!nextOrder) return yield* new HttpApiError.BadRequest();
					const project = yield* Effect.try({
						try: () => encodeWebEditorProject(nextConfig).project,
						catch: () => new HttpApiError.BadRequest(),
					});
					if (project.savedAt === priorProject?.savedAt) {
						project.savedAt = new Date(Date.now() + 1).toISOString();
					}
					const database = yield* Database;
					const savedProject = JSON.stringify(project);
					const newClip = JSON.stringify(clip);
					const savedImports = JSON.stringify(nextOrder);
					const updated: unknown = yield* database
						.use((client) =>
							client
								.update(videos)
								.set({
									metadata: sql`JSON_SET(${videoMetadataObject()}, '$.webEditorProject', CAST(${savedProject} AS JSON), '$.webEditorClips', JSON_OBJECT('version', 1, 'items', JSON_ARRAY_APPEND(COALESCE(JSON_EXTRACT(${videos.metadata}, '$.webEditorClips.items'), JSON_ARRAY()), '$', CAST(${newClip} AS JSON))), '$.webEditorImports', CAST(${savedImports} AS JSON))`,
								})
								.where(
									and(
										eq(videos.id, video.id),
										eq(videos.ownerId, video.ownerId),
										sql`COALESCE(JSON_LENGTH(JSON_EXTRACT(${videos.metadata}, '$.webEditorClips.items')), 0) = ${saved.length}`,
										sql`COALESCE(JSON_LENGTH(JSON_EXTRACT(${videos.metadata}, '$.webEditorImports.items')), 0) = ${priorImports?.items.length ?? 0}`,
										sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.webEditorProject.savedAt')) <=> ${priorProject?.savedAt ?? null}`,
									),
								),
						)
						.pipe(
							Effect.catchTag("DatabaseError", () =>
								Effect.fail(new HttpApiError.InternalServerError()),
							),
						);
					if (!affectedOne(updated)) return yield* new HttpApiError.Conflict();
					return { count: 1 };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;

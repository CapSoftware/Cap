import { videos } from "@cap/database/schema";
import { Database } from "@cap/web-backend";
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
import {
	decodeWebEditorProject,
	encodeWebEditorProject,
} from "@/lib/editor-project-storage";
import {
	loadEligibleEditorVideo,
	requestMediaEditor,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import { validEditorVideoAsset } from "@/lib/editor-video-upload";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

class Api extends HttpApi.make("WebEditorClipsApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("append", "/api/editor/sessions/:id/clips")
			.setPath(Schema.Struct({ id: Schema.String }))
			.setPayload(
				Schema.Struct({
					videoId: Video.VideoId,
					path: Schema.String,
					jobId: Schema.String,
					camera: Schema.optional(
						Schema.Struct({
							path: Schema.String,
							jobId: Schema.String,
							offsetMs: Schema.Number,
						}),
					),
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

const clipPath =
	/^content\/videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm)$/;
const jobIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const readReadyImport = Effect.fn("WebEditorClips.readReadyImport")(function* (
	sessionPath: string,
	jobId: string,
	path: string,
) {
	const response = yield* requestMediaEditor(
		`${sessionPath}/video-assets/${encodeURIComponent(jobId)}`,
	);
	if (response.status === 404) return yield* new HttpApiError.NotFound();
	if (!response.ok) return yield* new HttpApiError.ServiceUnavailable();
	const job: unknown = yield* Effect.tryPromise({
		try: () => response.json(),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	if (
		!asRecord(job) ||
		job.id !== jobId ||
		job.status !== "ready" ||
		!asRecord(job.result) ||
		job.result.path !== path ||
		typeof job.result.duration !== "number" ||
		typeof job.result.fps !== "number" ||
		typeof job.result.hasAudio !== "boolean"
	) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	return {
		duration: job.result.duration,
		fps: job.result.fps,
		hasAudio: job.result.hasAudio,
	};
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("append", ({ path, payload }) =>
				Effect.gen(function* () {
					if (
						!clipPath.test(payload.path) ||
						!jobIdPattern.test(payload.jobId) ||
						(payload.camera !== undefined &&
							(!clipPath.test(payload.camera.path) ||
								payload.camera.path === payload.path ||
								!jobIdPattern.test(payload.camera.jobId) ||
								!Number.isSafeInteger(payload.camera.offsetMs) ||
								Math.abs(payload.camera.offsetMs) > 30_000))
					) {
						return yield* new HttpApiError.BadRequest();
					}
					const video = yield* loadEligibleEditorVideo(payload.videoId);
					const sessionPath = yield* verifyOwnedEditorSession(
						payload.videoId,
						path.id,
					);
					const assets = video.metadata?.webEditorVideos?.items ?? [];
					const eligibleAsset = (assetPath: string) => {
						const asset = assets.find((item) => item.path === assetPath);
						return (
							!!asset && validEditorVideoAsset(asset, video.ownerId, video.id)
						);
					};
					if (
						video.metadata?.webEditorVideos?.version !== 1 ||
						!eligibleAsset(payload.path) ||
						(payload.camera !== undefined &&
							!eligibleAsset(payload.camera.path))
					) {
						return yield* new HttpApiError.NotFound();
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
							existing.cameraPath !== payload.camera?.path ||
							existing.cameraOffsetMs !== payload.camera?.offsetMs
						)
							return yield* new HttpApiError.Conflict();
						return { count: 1 };
					}
					if (saved.length >= MAX_WEB_EDITOR_CLIPS) {
						return yield* new HttpApiError.BadRequest();
					}
					const displayImport = yield* readReadyImport(
						sessionPath,
						payload.jobId,
						payload.path,
					);
					const cameraImport = payload.camera
						? yield* readReadyImport(
								sessionPath,
								payload.camera.jobId,
								payload.camera.path,
							)
						: null;
					const clip = {
						displayPath: payload.path,
						duration: displayImport.duration,
						fps: displayImport.fps,
						hasAudio: displayImport.hasAudio,
						...(payload.camera && cameraImport
							? {
									cameraPath: payload.camera.path,
									cameraFps: cameraImport.fps,
									cameraOffsetMs: payload.camera.offsetMs,
								}
							: {}),
					};
					if (!validWebEditorClip(clip, assets, video.ownerId, video.id)) {
						return yield* new HttpApiError.BadRequest();
					}
					const instanceResponse = yield* requestMediaEditor(
						`${sessionPath}/instance`,
					);
					if (!instanceResponse.ok)
						return yield* new HttpApiError.ServiceUnavailable();
					const instance: unknown = yield* Effect.tryPromise({
						try: () => instanceResponse.json(),
						catch: () => new HttpApiError.ServiceUnavailable(),
					});
					if (
						!asRecord(instance) ||
						typeof instance.recordingDuration !== "number" ||
						!Number.isFinite(instance.recordingDuration) ||
						instance.recordingDuration <= 0 ||
						!asRecord(instance.savedProjectConfig)
					) {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					const priorProject = video.metadata?.webEditorProject;
					const priorConfig = priorProject
						? decodeWebEditorProject(priorProject)
						: instance.savedProjectConfig;
					if (!priorConfig) return yield* new HttpApiError.ServiceUnavailable();
					const nextConfig = appendWebEditorClipToConfig(
						priorConfig,
						nextEditorRecordingSegmentIndex(order),
						instance.recordingDuration,
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
						catch: () => new HttpApiError.ServiceUnavailable(),
					});
					const database = yield* Database;
					const savedProject = JSON.stringify(project);
					const newClip = JSON.stringify(clip);
					const savedImports = JSON.stringify(nextOrder);
					const updated: unknown = yield* database
						.use((client) =>
							client
								.update(videos)
								.set({
									metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.webEditorProject', CAST(${savedProject} AS JSON), '$.webEditorClips', JSON_OBJECT('version', 1, 'items', JSON_ARRAY_APPEND(COALESCE(JSON_EXTRACT(${videos.metadata}, '$.webEditorClips.items'), JSON_ARRAY()), '$', CAST(${newClip} AS JSON))), '$.webEditorImports', CAST(${savedImports} AS JSON))`,
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

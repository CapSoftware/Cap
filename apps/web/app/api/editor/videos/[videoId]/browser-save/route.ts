import { videos } from "@cap/database/schema";
import { Database, Storage } from "@cap/web-backend";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { start } from "workflow/api";
import {
	BROWSER_SAVE_CHUNK_FILE,
	browserSaveChunkKey,
} from "@/lib/browser-save-chunks";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";
import { clearBrowserSaveChunksWorkflow } from "@/workflows/clear-browser-save-chunks";

export const dynamic = "force-dynamic";

const path = Schema.Struct({ videoId: Video.VideoId });
const SaveId = Schema.UUID;

class Api extends HttpApi.make("WebEditorBrowserSaveApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.put(
				"progress",
				"/api/editor/videos/:videoId/browser-save",
			)
				.setPath(path)
				.setPayload(
					Schema.Struct({
						progress: Schema.Number.pipe(Schema.between(0, 1)),
						saveId: Schema.optional(SaveId),
						chunks: Schema.optional(
							Schema.Array(Schema.Number.pipe(Schema.between(0, 30))).pipe(
								Schema.maxItems(20_000),
							),
						),
					}),
				)
				.addSuccess(Schema.Void, { status: 204 })
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.post(
				"chunkUpload",
				"/api/editor/videos/:videoId/browser-save",
			)
				.setPath(path)
				.setPayload(
					Schema.Struct({
						saveId: SaveId,
						file: Schema.String.pipe(Schema.pattern(BROWSER_SAVE_CHUNK_FILE)),
					}),
				)
				.addSuccess(Schema.Struct({ url: Schema.String }))
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.del("finish", "/api/editor/videos/:videoId/browser-save")
				.setPath(path)
				.addSuccess(Schema.Void, { status: 204 })
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

const writeMetadata = (
	videoId: Video.VideoId,
	metadata: ReturnType<typeof sql>,
) =>
	Effect.gen(function* () {
		const database = yield* Database;
		yield* database
			.use((client) =>
				client.update(videos).set({ metadata }).where(eq(videos.id, videoId)),
			)
			.pipe(
				Effect.catchTag("DatabaseError", () =>
					Effect.fail(new HttpApiError.InternalServerError()),
				),
			);
	});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("progress", ({ path, payload }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(path.videoId, true);
						yield* writeMetadata(
							video.id,
							sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.browserSave', CAST(${JSON.stringify({ updatedAt: new Date().toISOString(), progress: payload.progress, saveId: payload.saveId, chunks: payload.chunks })} AS JSON))`,
						);
					}),
				)
				.handle("chunkUpload", ({ path, payload }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(path.videoId, true);
						const [bucket] = yield* Storage.getAccessForVideo(
							decodeStorageVideo(video),
						).pipe(
							Effect.catchAll(() =>
								Effect.fail(new HttpApiError.InternalServerError()),
							),
						);
						const url = yield* bucket
							.getPresignedPutUrl(
								browserSaveChunkKey(
									video.ownerId,
									video.id,
									payload.saveId,
									payload.file,
								),
								{
									ContentType: payload.file.endsWith(".m4s")
										? "video/iso.segment"
										: "video/mp4",
								},
								{ expiresIn: 60 * 10 },
							)
							.pipe(
								Effect.catchAll(() =>
									Effect.fail(new HttpApiError.InternalServerError()),
								),
							);
						return { url };
					}),
				)
				.handle("finish", ({ path }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(path.videoId, true);
						const save = video.metadata?.browserSave;
						if (!save) return;
						// Keeps its chunks listed, so viewers part way through them finish.
						yield* writeMetadata(
							video.id,
							sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.browserSave', JSON_MERGE_PATCH(COALESCE(JSON_EXTRACT(${videos.metadata}, '$.browserSave'), JSON_OBJECT()), JSON_OBJECT('updatedAt', ${new Date().toISOString()}, 'progress', 1, 'finished', true)))`,
						);
						if (save.saveId)
							yield* Effect.promise(() =>
								start(clearBrowserSaveChunksWorkflow, [
									{ videoId: video.id },
								]).catch((error) => {
									console.error("Failed to queue browser save chunk cleanup", {
										videoId: video.id,
										error,
									});
								}),
							);
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const PUT = handler;
export const DELETE = handler;
export const POST = handler;

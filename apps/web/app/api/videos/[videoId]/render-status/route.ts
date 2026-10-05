import { videos } from "@cap/database/schema";
import { Database, provideOptionalAuth, Videos } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { refreshRenderFarmSave } from "@/lib/render-farm-save";
import { renderFarmSaveIsCurrent } from "@/lib/render-farm-status";
import { apiToHandler } from "@/lib/server";
import { shareVideoRevision } from "@/lib/share-video-revision";

export const dynamic = "force-dynamic";

const RenderSaveStatus = Schema.Struct({
	state: Schema.Literal("idle", "rendering", "ready", "error"),
	exportId: Schema.NullOr(Schema.String),
	progress: Schema.Number,
	playable: Schema.Boolean,
	hlsUrl: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	current: Schema.Boolean,
	revision: Schema.NullOr(Schema.String),
});

class Api extends HttpApi.make("RenderSaveStatusApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("status", "/api/videos/:videoId/render-status")
			.setPath(Schema.Struct({ videoId: Video.VideoId }))
			.addSuccess(RenderSaveStatus)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.Unauthorized)
			.addError(HttpApiError.InternalServerError),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			Effect.gen(function* () {
				const videosService = yield* Videos;
				const database = yield* Database;
				return handlers.handle("status", ({ path }) =>
					Effect.gen(function* () {
						yield* videosService.getByIdForViewing(path.videoId).pipe(
							Effect.flatten,
							Effect.catchTag("NoSuchElementException", () =>
								Effect.fail(new HttpApiError.NotFound()),
							),
						);
						const [video] = yield* database.use((client) =>
							client
								.select({
									id: videos.id,
									fps: videos.fps,
									metadata: videos.metadata,
									source: videos.source,
								})
								.from(videos)
								.where(eq(videos.id, path.videoId)),
						);
						if (!video) return yield* new HttpApiError.NotFound();
						const status = yield* Effect.tryPromise({
							try: () => refreshRenderFarmSave(video),
							catch: () => new HttpApiError.InternalServerError(),
						});
						const published =
							video.metadata?.renderFarmSave?.status === "rendering" &&
							status.state === "ready";
						const [current] = published
							? yield* database.use((client) =>
									client
										.select({ source: videos.source })
										.from(videos)
										.where(eq(videos.id, path.videoId)),
								)
							: [video];
						return {
							...status,
							current: renderFarmSaveIsCurrent(video.metadata),
							revision: shareVideoRevision((current ?? video).source),
						};
					}).pipe(
						provideOptionalAuth,
						Effect.catchTags({
							VerifyVideoPasswordError: () =>
								Effect.fail(new HttpApiError.Forbidden()),
							PolicyDenied: () => Effect.fail(new HttpApiError.Unauthorized()),
							DatabaseError: () =>
								Effect.fail(new HttpApiError.InternalServerError()),
							UnknownException: () =>
								Effect.fail(new HttpApiError.InternalServerError()),
						}),
					),
				);
			}),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;

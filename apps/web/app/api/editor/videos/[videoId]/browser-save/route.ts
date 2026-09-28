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
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

const path = Schema.Struct({ videoId: Video.VideoId });

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
					}),
				)
				.addSuccess(Schema.Void, { status: 204 })
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
						const now = new Date().toISOString();
						const startedAt = video.metadata?.browserSave?.startedAt ?? now;
						yield* writeMetadata(
							video.id,
							sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.browserSave', JSON_OBJECT('version', 1, 'startedAt', ${startedAt}, 'updatedAt', ${now}, 'progress', ${payload.progress}))`,
						);
					}),
				)
				.handle("finish", ({ path }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(path.videoId, true);
						if (!video.metadata?.browserSave) return;
						yield* writeMetadata(
							video.id,
							sql`JSON_REMOVE(${videos.metadata}, '$.browserSave')`,
						);
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const PUT = handler;
export const DELETE = handler;

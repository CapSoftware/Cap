import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Database, Storage } from "@cap/web-backend";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
} from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import {
	CURSOR_RECONSTRUCTION_TIMEOUT_MS,
	cursorReconstructionView,
} from "@/lib/cursor-reconstruction";
import {
	refreshCursorReconstruction,
	setCursorReconstructionEnabled,
	startCursorReconstruction,
} from "@/lib/cursor-reconstruction-jobs";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { renderFarmConfig } from "@/lib/render-farm";
import { apiToHandler } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const View = Schema.Struct({
	eligible: Schema.Boolean,
	blocker: Schema.NullOr(Schema.String),
	status: Schema.Literal("idle", "processing", "ready", "error"),
	enabled: Schema.Boolean,
	progress: Schema.Number,
	error: Schema.NullOr(Schema.String),
	cursorData: Schema.Boolean,
});

const path = "/api/editor/videos/:videoId/cursor-reconstruction";
const VideoPath = Schema.Struct({ videoId: Video.VideoId });

class Api extends HttpApi.make("CursorReconstructionApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("status", path)
				.setPath(VideoPath)
				.addSuccess(View)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.post("start", path)
				.setPath(VideoPath)
				.addSuccess(View)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.patch("toggle", path)
				.setPath(VideoPath)
				.setPayload(Schema.Struct({ enabled: Schema.Boolean }))
				.addSuccess(View)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

const sameOrigin = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest;
	const origin = new URL(request.originalUrl).origin;
	if (request.headers.origin && request.headers.origin !== origin) {
		return yield* new HttpApiError.Forbidden();
	}
	return origin;
});

const currentView = Effect.fn("cursorReconstructionCurrentView")(function* (
	videoId: Video.VideoId,
) {
	const database = yield* Database;
	const [row] = yield* database
		.use((client) =>
			client
				.select({
					id: videos.id,
					ownerId: videos.ownerId,
					duration: videos.duration,
					metadata: videos.metadata,
				})
				.from(videos)
				.where(eq(videos.id, videoId)),
		)
		.pipe(
			Effect.catchTag("DatabaseError", () =>
				Effect.fail(new HttpApiError.InternalServerError()),
			),
		);
	if (!row) return yield* new HttpApiError.NotFound();
	return cursorReconstructionView(row);
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("status", ({ path }) =>
					Effect.gen(function* () {
						const video = yield* loadEligibleEditorVideo(path.videoId);
						const config = renderFarmConfig();
						if (config) {
							yield* Effect.tryPromise(() =>
								refreshCursorReconstruction(video, config),
							).pipe(Effect.ignore);
						}
						return yield* currentView(video.id);
					}),
				)
				.handle("start", ({ path }) =>
					Effect.gen(function* () {
						const origin = yield* sameOrigin;
						const video = yield* loadEligibleEditorVideo(path.videoId);
						const view = cursorReconstructionView(video);
						if (!view.eligible) return yield* new HttpApiError.Forbidden();
						const run = video.metadata?.cursorReconstruction;
						if (
							view.status === "ready" ||
							(view.status === "processing" &&
								run &&
								Date.now() - Date.parse(run.startedAt) <
									CURSOR_RECONSTRUCTION_TIMEOUT_MS)
						) {
							return view;
						}
						const config = renderFarmConfig();
						if (!config) return yield* new HttpApiError.ServiceUnavailable();
						const [storage] = yield* Storage.getAccessForVideo(
							decodeStorageVideo(video),
							{ resolvePublishedOutput: false },
						).pipe(
							Effect.catchTag("StorageError", () =>
								Effect.fail(new HttpApiError.ServiceUnavailable()),
							),
						);
						// The farm reads and writes only Cap's own bucket.
						if (
							storage.provider !== "s3" ||
							storage.bucketName !== serverEnv().CAP_AWS_BUCKET
						) {
							return yield* new HttpApiError.Forbidden();
						}
						yield* Effect.tryPromise({
							try: () => startCursorReconstruction(video, config, origin),
							catch: () => new HttpApiError.ServiceUnavailable(),
						});
						return yield* currentView(video.id);
					}),
				)
				.handle("toggle", ({ path, payload }) =>
					Effect.gen(function* () {
						yield* sameOrigin;
						const video = yield* loadEligibleEditorVideo(path.videoId);
						const view = cursorReconstructionView(video);
						if (payload.enabled && view.status !== "ready") {
							return yield* new HttpApiError.Conflict();
						}
						yield* Effect.tryPromise({
							try: () =>
								setCursorReconstructionEnabled(video.id, payload.enabled),
							catch: () => new HttpApiError.InternalServerError(),
						});
						return yield* currentView(video.id);
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;
export const PATCH = handler;

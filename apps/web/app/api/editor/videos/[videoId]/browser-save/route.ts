import { randomUUID } from "node:crypto";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { hasEditorCaptionContent } from "@/lib/editor-caption-access";
import { decodeWebEditorProject } from "@/lib/editor-project-storage";
import { editorRequestOrigin } from "@/lib/editor-request-origin";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { enqueuePreviewAssetsRefresh } from "@/lib/refresh-preview-assets";
import {
	recordBrowserSave,
	updateBrowserSave,
} from "@/lib/render-farm-records";
import { canSaveEditorVideo } from "@/lib/render-farm-start";
import { savedProjectIsPublished } from "@/lib/render-farm-status";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

const VideoPath = Schema.Struct({ videoId: Video.VideoId });
const SaveId = Schema.String.pipe(Schema.pattern(/^[0-9a-f-]{36}$/));

class Api extends HttpApi.make("WebEditorBrowserSaveApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.post("start", "/api/editor/videos/:videoId/browser-save")
				.setPath(VideoPath)
				.addSuccess(Schema.Struct({ saveId: Schema.String }))
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.put("report", "/api/editor/videos/:videoId/browser-save")
				.setPath(VideoPath)
				.setPayload(
					Schema.Struct({
						saveId: SaveId,
						progress: Schema.optional(Schema.Number.pipe(Schema.between(0, 1))),
						status: Schema.optional(Schema.Literal("published", "error")),
						error: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
					}),
				)
				.addSuccess(Schema.Struct({ ok: Schema.Boolean }))
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.Conflict)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

const sameOrigin = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest;
	const origin = editorRequestOrigin(
		request.originalUrl,
		request.headers.origin,
	);
	if (!origin) return yield* new HttpApiError.Forbidden();
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("start", ({ path }) =>
					Effect.gen(function* () {
						yield* sameOrigin;
						const video = yield* loadEligibleEditorVideo(path.videoId, true);
						if (!canSaveEditorVideo(video)) {
							return yield* new HttpApiError.Forbidden();
						}
						const project = video.metadata?.webEditorProject;
						const config = project ? decodeWebEditorProject(project) : null;
						if (!video.captionsEnabled && hasEditorCaptionContent(config)) {
							return yield* new HttpApiError.Forbidden();
						}
						if (savedProjectIsPublished(video.metadata)) {
							return yield* new HttpApiError.Conflict();
						}
						const now = new Date().toISOString();
						const saveId = randomUUID();
						yield* Effect.tryPromise({
							try: () =>
								recordBrowserSave(video.id, {
									version: 1,
									saveId,
									status: "rendering",
									projectSavedAt: project?.savedAt ?? null,
									progress: 0,
									startedAt: now,
									updatedAt: now,
								}),
							catch: () => new HttpApiError.InternalServerError(),
						});
						return { saveId };
					}),
				)
				.handle("report", ({ path, payload }) =>
					Effect.gen(function* () {
						yield* sameOrigin;
						const video = yield* loadEligibleEditorVideo(path.videoId, true);
						const change =
							payload.status === "published"
								? ({ status: "published" } as const)
								: payload.status === "error"
									? ({
											status: "error",
											error:
												payload.error ??
												"This save couldn't finish. Try again.",
										} as const)
									: payload.progress !== undefined
										? { progress: payload.progress }
										: null;
						if (!change) return yield* new HttpApiError.BadRequest();
						const updated = yield* Effect.tryPromise({
							try: () => updateBrowserSave(video.id, payload.saveId, change),
							catch: () => new HttpApiError.InternalServerError(),
						});
						if (!updated) return yield* new HttpApiError.Conflict();
						if (payload.status === "published") {
							yield* Effect.promise(() =>
								enqueuePreviewAssetsRefresh(video.id),
							);
						}
						return { ok: true };
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
export const PUT = handler;

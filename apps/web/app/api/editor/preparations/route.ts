import { serverEnv } from "@cap/env";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import {
	getSignedEditorSources,
	loadEligibleEditorVideo,
	requestMediaEditor,
} from "@/lib/editor-session";
import {
	editorWorkerIdFromSessionId,
	orderedEditorWorkers,
	parseEditorWorkerPool,
} from "@/lib/editor-worker-routing";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

class EditorCapacityBusy extends Schema.TaggedError<EditorCapacityBusy>()(
	"EditorCapacityBusy",
	{ retryAfterMs: Schema.Number },
) {}

class Api extends HttpApi.make("WebEditorPreparationApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("prepare")`/api/editor/preparations`
			.setPayload(Schema.Struct({ videoId: Video.VideoId }))
			.addSuccess(
				Schema.Struct({
					id: Schema.String,
					status: Schema.Literal("preparing"),
				}),
			)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.ServiceUnavailable)
			.addError(EditorCapacityBusy, { status: 503 })
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("prepare", ({ payload }) =>
				Effect.gen(function* () {
					const video = yield* loadEligibleEditorVideo(payload.videoId);
					const sources = yield* getSignedEditorSources(video);
					const env = serverEnv();
					const workers = yield* Effect.try({
						try: () =>
							orderedEditorWorkers(
								parseEditorWorkerPool(
									env.CAP_WEB_EDITOR_WORKER_POOL,
									env.CAP_WEB_EDITOR_WORKER_URL,
								),
								video.id,
							),
						catch: () => new HttpApiError.ServiceUnavailable(),
					});
					if (workers.length === 0) {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					let occupiedWorkers = 0;
					for (const worker of workers) {
						const attempt = yield* requestMediaEditor(
							"/editor/preparations",
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify(sources),
							},
							15_000,
							worker.id,
						).pipe(Effect.either);
						if (attempt._tag === "Left") continue;
						const response = attempt.right;
						if (response.status >= 500) {
							if (response.status === 503) {
								const detail = yield* Effect.tryPromise({
									try: async (): Promise<unknown> => await response.json(),
									catch: () => new HttpApiError.ServiceUnavailable(),
								}).pipe(Effect.either);
								if (
									detail._tag === "Right" &&
									typeof detail.right === "object" &&
									detail.right !== null &&
									"error" in detail.right &&
									detail.right.error === "Editor render capacity is busy"
								) {
									occupiedWorkers++;
								}
							}
							continue;
						}
						if (response.status !== 202) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						const data: unknown = yield* Effect.tryPromise({
							try: () => response.json(),
							catch: () => new HttpApiError.ServiceUnavailable(),
						});
						if (
							typeof data === "object" &&
							data !== null &&
							"id" in data &&
							typeof data.id === "string" &&
							"status" in data &&
							data.status === "preparing" &&
							editorWorkerIdFromSessionId(data.id) === worker.id
						) {
							return { id: data.id, status: "preparing" as const };
						}
						if (
							typeof data === "object" &&
							data !== null &&
							"id" in data &&
							typeof data.id === "string"
						) {
							yield* requestMediaEditor(
								`/editor/preparations/${encodeURIComponent(data.id)}`,
								{ method: "DELETE" },
								15_000,
								worker.id,
							).pipe(Effect.either);
						}
						return yield* new HttpApiError.ServiceUnavailable();
					}
					if (occupiedWorkers === workers.length) {
						return yield* new EditorCapacityBusy({ retryAfterMs: 8_000 });
					}
					return yield* new HttpApiError.ServiceUnavailable();
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;

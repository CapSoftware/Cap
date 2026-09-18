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
	loadEligibleEditorVideo,
	requestMediaEditor,
} from "@/lib/editor-session";
import { editorWorkerIdFromSessionId } from "@/lib/editor-worker-routing";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

const Status = Schema.Literal(
	"preparing",
	"ready",
	"error",
	"canceled",
	"closed",
);

class Api extends HttpApi.make("WebEditorPreparationStatusApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("status", "/api/editor/preparations/:id")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setUrlParams(Schema.Struct({ videoId: Video.VideoId }))
				.addSuccess(
					Schema.Struct({
						status: Status,
						sessionId: Schema.optional(Schema.String),
					}),
				)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.del("cancel", "/api/editor/preparations/:id")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setUrlParams(Schema.Struct({ videoId: Video.VideoId }))
				.addSuccess(Schema.Struct({ canceled: Schema.Boolean }))
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

const getStatus = Effect.fn("getWebEditorPreparationStatus")(function* (
	id: string,
	videoId: Video.VideoId,
) {
	const video = yield* loadEligibleEditorVideo(videoId);
	const response = yield* requestMediaEditor(
		`/editor/preparations/${encodeURIComponent(id)}`,
	);
	if (response.status === 404) return yield* new HttpApiError.NotFound();
	if (!response.ok) return yield* new HttpApiError.ServiceUnavailable();
	const data: unknown = yield* Effect.tryPromise({
		try: () => response.json(),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	if (
		typeof data !== "object" ||
		data === null ||
		!("videoId" in data) ||
		data.videoId !== video.id ||
		!("status" in data) ||
		(data.status !== "preparing" &&
			data.status !== "ready" &&
			data.status !== "error" &&
			data.status !== "canceled" &&
			data.status !== "closed")
	) {
		return yield* new HttpApiError.NotFound();
	}
	const status = data.status;
	const sessionId =
		"sessionId" in data && typeof data.sessionId === "string"
			? data.sessionId
			: undefined;
	if (
		(status === "ready" && !sessionId) ||
		(sessionId &&
			editorWorkerIdFromSessionId(sessionId) !==
				editorWorkerIdFromSessionId(id))
	) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	return { status, ...(sessionId ? { sessionId } : {}) } as const;
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("status", ({ path, urlParams }) =>
					getStatus(path.id, urlParams.videoId),
				)
				.handle("cancel", ({ path, urlParams }) =>
					Effect.gen(function* () {
						yield* getStatus(path.id, urlParams.videoId);
						const response = yield* requestMediaEditor(
							`/editor/preparations/${encodeURIComponent(path.id)}`,
							{ method: "DELETE" },
						);
						if (response.status !== 204) {
							return yield* new HttpApiError.ServiceUnavailable();
						}
						return { canceled: true };
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const DELETE = handler;

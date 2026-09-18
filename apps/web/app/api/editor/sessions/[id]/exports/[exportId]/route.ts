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
import {
	requestMediaEditor,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

const ExportProgress = Schema.Struct({
	rendered_count: Schema.Number,
	total_frames: Schema.Number,
});
const ExportState = Schema.Struct({
	id: Schema.String,
	status: Schema.Literal("running", "ready", "error", "canceled"),
	format: Schema.Literal("Mp4", "Gif", "Mov"),
	progress: Schema.NullOr(ExportProgress),
	error: Schema.NullOr(Schema.String),
	downloadStartedAt: Schema.NullOr(Schema.Number),
	size: Schema.NullOr(Schema.Number),
	mediaMetadata: Schema.NullOr(
		Schema.Struct({
			duration: Schema.Number,
			width: Schema.Number,
			height: Schema.Number,
			fps: Schema.Number,
		}),
	),
	startedAt: Schema.Number,
});

class Api extends HttpApi.make("WebEditorExportJobApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get(
				"status",
				"/api/editor/sessions/:id/exports/:exportId",
			)
				.setPath(Schema.Struct({ id: Schema.String, exportId: Schema.String }))
				.setUrlParams(Schema.Struct({ videoId: Video.VideoId }))
				.addSuccess(ExportState)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.del(
				"cancel",
				"/api/editor/sessions/:id/exports/:exportId",
			)
				.setPath(Schema.Struct({ id: Schema.String, exportId: Schema.String }))
				.setUrlParams(Schema.Struct({ videoId: Video.VideoId }))
				.addSuccess(Schema.Struct({ canceled: Schema.Boolean }))
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
				.handle("status", ({ path, urlParams }) =>
					Effect.gen(function* () {
						const sessionPath = yield* verifyOwnedEditorSession(
							urlParams.videoId,
							path.id,
						);
						const response = yield* requestMediaEditor(
							`${sessionPath}/exports/${encodeURIComponent(path.exportId)}`,
						);
						if (response.status === 404)
							return yield* new HttpApiError.NotFound();
						if (!response.ok)
							return yield* new HttpApiError.ServiceUnavailable();
						const state: unknown = yield* Effect.tryPromise({
							try: () => response.json(),
							catch: () => new HttpApiError.ServiceUnavailable(),
						});
						return yield* Schema.decodeUnknown(ExportState)(state).pipe(
							Effect.mapError(() => new HttpApiError.ServiceUnavailable()),
						);
					}),
				)
				.handle("cancel", ({ path, urlParams }) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const origin = new URL(request.url).origin;
						if (request.headers.origin && request.headers.origin !== origin) {
							return yield* new HttpApiError.Forbidden();
						}
						const sessionPath = yield* verifyOwnedEditorSession(
							urlParams.videoId,
							path.id,
						);
						const response = yield* requestMediaEditor(
							`${sessionPath}/exports/${encodeURIComponent(path.exportId)}`,
							{ method: "DELETE" },
						);
						if (response.status === 404)
							return yield* new HttpApiError.NotFound();
						if (response.status !== 204)
							return yield* new HttpApiError.ServiceUnavailable();
						return { canceled: true };
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const DELETE = handler;

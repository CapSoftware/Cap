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
import {
	loadEligibleEditorVideo,
	requestMediaEditor,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

class Api extends HttpApi.make("WebEditorExportStartApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("start", "/api/editor/sessions/:id/exports")
			.setPath(Schema.Struct({ id: Schema.String }))
			.setPayload(
				Schema.Struct({ videoId: Video.VideoId, settings: Schema.Unknown }),
			)
			.addSuccess(
				Schema.Struct({ id: Schema.String, status: Schema.Literal("running") }),
			)
			.addError(HttpApiError.BadRequest)
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
			handlers.handle("start", ({ path, payload }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const origin = new URL(request.originalUrl).origin;
					if (request.headers.origin && request.headers.origin !== origin) {
						return yield* new HttpApiError.Forbidden();
					}
					const sessionPath = yield* verifyOwnedEditorSession(
						payload.videoId,
						path.id,
					);
					const video = yield* loadEligibleEditorVideo(payload.videoId);
					if (!video.captionsEnabled) {
						const current = yield* requestMediaEditor(`${sessionPath}/config`);
						if (!current.ok)
							return yield* new HttpApiError.ServiceUnavailable();
						const config: unknown = yield* Effect.tryPromise({
							try: () => current.json(),
							catch: () => new HttpApiError.ServiceUnavailable(),
						});
						if (hasEditorCaptionContent(config)) {
							return yield* new HttpApiError.Forbidden();
						}
					}
					if (
						typeof payload.settings !== "object" ||
						payload.settings === null ||
						Array.isArray(payload.settings)
					) {
						return yield* new HttpApiError.BadRequest();
					}
					const settings = JSON.stringify(payload.settings);
					if (Buffer.byteLength(settings, "utf8") > 16 * 1024) {
						return yield* new HttpApiError.BadRequest();
					}
					const response = yield* requestMediaEditor(`${sessionPath}/exports`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: settings,
					});
					if (response.status === 400)
						return yield* new HttpApiError.BadRequest();
					if (response.status === 404)
						return yield* new HttpApiError.NotFound();
					if (response.status !== 202)
						return yield* new HttpApiError.ServiceUnavailable();
					const result: unknown = yield* Effect.tryPromise({
						try: () => response.json(),
						catch: () => new HttpApiError.ServiceUnavailable(),
					});
					if (
						typeof result !== "object" ||
						result === null ||
						!("id" in result) ||
						typeof result.id !== "string" ||
						!("status" in result) ||
						result.status !== "running"
					) {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					return { id: result.id, status: "running" as const };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;

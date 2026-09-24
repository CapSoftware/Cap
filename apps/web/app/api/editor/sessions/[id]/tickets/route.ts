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
	loadEligibleEditorVideo,
	requestMediaEditor,
} from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

const Socket = Schema.Struct({ url: Schema.String, ticket: Schema.String });

class Api extends HttpApi.make("WebEditorSocketApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("tickets", "/api/editor/sessions/:id/tickets")
			.setPath(Schema.Struct({ id: Schema.String }))
			.setPayload(Schema.Struct({ videoId: Video.VideoId }))
			.addSuccess(
				Schema.Struct({
					frames: Socket,
					audio: Socket,
					events: Socket,
					commands: Socket,
				}),
			)
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
			handlers.handle("tickets", ({ path, payload }) =>
				Effect.gen(function* () {
					const video = yield* loadEligibleEditorVideo(payload.videoId);
					const sessionPath = `/editor/sessions/${encodeURIComponent(path.id)}`;
					const identity = yield* requestMediaEditor(sessionPath);
					if (identity.status === 404)
						return yield* new HttpApiError.NotFound();
					if (!identity.ok) return yield* new HttpApiError.ServiceUnavailable();
					const info: unknown = yield* Effect.tryPromise({
						try: () => identity.json(),
						catch: () => new HttpApiError.ServiceUnavailable(),
					});
					if (
						typeof info !== "object" ||
						info === null ||
						!("videoId" in info) ||
						info.videoId !== video.id
					) {
						return yield* new HttpApiError.NotFound();
					}
					const request = yield* HttpServerRequest.HttpServerRequest;
					const origin = new URL(request.originalUrl).origin;
					if (request.headers.origin && request.headers.origin !== origin) {
						return yield* new HttpApiError.Forbidden();
					}
					const response = yield* requestMediaEditor(`${sessionPath}/sockets`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ origin }),
					});
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
						!("sockets" in data) ||
						typeof data.sockets !== "object" ||
						data.sockets === null
					) {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					const sockets = data.sockets as Record<string, unknown>;
					const validSocket = (
						value: unknown,
					): value is { url: string; ticket: string } =>
						typeof value === "object" &&
						value !== null &&
						"url" in value &&
						typeof value.url === "string" &&
						"ticket" in value &&
						typeof value.ticket === "string";
					if (
						!validSocket(sockets.frames) ||
						!validSocket(sockets.audio) ||
						!validSocket(sockets.events) ||
						!validSocket(sockets.commands)
					) {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					return {
						frames: sockets.frames,
						audio: sockets.audio,
						events: sockets.events,
						commands: sockets.commands,
					};
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;

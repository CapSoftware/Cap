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

class Api extends HttpApi.make("WebEditorExportDownloadTicketApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post(
			"ticket",
			"/api/editor/sessions/:id/exports/:exportId/download-ticket",
		)
			.setPath(Schema.Struct({ id: Schema.String, exportId: Schema.String }))
			.setPayload(
				Schema.Struct({
					videoId: Video.VideoId,
					fileName: Schema.optional(Schema.String),
				}),
			)
			.addSuccess(Schema.Struct({ url: Schema.String }))
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
			handlers.handle("ticket", ({ path, payload }) =>
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
					const response = yield* requestMediaEditor(
						`${sessionPath}/exports/${encodeURIComponent(path.exportId)}/download-ticket`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ fileName: payload.fileName }),
						},
					);
					if (response.status === 404)
						return yield* new HttpApiError.NotFound();
					if (!response.ok) return yield* new HttpApiError.ServiceUnavailable();
					const value: unknown = yield* Effect.tryPromise({
						try: () => response.json(),
						catch: () => new HttpApiError.ServiceUnavailable(),
					});
					if (
						typeof value !== "object" ||
						value === null ||
						!("url" in value) ||
						typeof value.url !== "string"
					) {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					let url: URL;
					try {
						url = new URL(value.url);
					} catch {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					if (
						(url.protocol !== "https:" &&
							!(
								url.protocol === "http:" &&
								["localhost", "127.0.0.1"].includes(url.hostname)
							)) ||
						url.username ||
						url.password ||
						url.hash ||
						url.pathname !==
							`${sessionPath}/exports/${encodeURIComponent(path.exportId)}/download` ||
						url.searchParams.size !== 1 ||
						!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("ticket") ?? "")
					) {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					return { url: url.toString() };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;

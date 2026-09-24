import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import {
	requestMediaEditor,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

class Api extends HttpApi.make("WebEditorExportChunkApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get(
			"chunk",
			"/api/editor/sessions/:id/exports/:exportId/chunk",
		)
			.setPath(Schema.Struct({ id: Schema.String, exportId: Schema.String }))
			.setUrlParams(
				Schema.Struct({
					videoId: Video.VideoId,
					offset: Schema.String,
					length: Schema.String,
				}),
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
			handlers.handle("chunk", ({ path, urlParams }) =>
				Effect.gen(function* () {
					if (
						!/^(0|[1-9][0-9]*)$/.test(urlParams.offset) ||
						!/^[1-9][0-9]*$/.test(urlParams.length)
					) {
						return yield* new HttpApiError.BadRequest();
					}
					const offset = Number(urlParams.offset);
					const length = Number(urlParams.length);
					if (
						!Number.isSafeInteger(offset) ||
						!Number.isSafeInteger(length) ||
						length > 16 * 1024 * 1024
					) {
						return yield* new HttpApiError.BadRequest();
					}
					const sessionPath = yield* verifyOwnedEditorSession(
						urlParams.videoId,
						path.id,
					);
					const response = yield* requestMediaEditor(
						`${sessionPath}/exports/${encodeURIComponent(path.exportId)}/chunk?offset=${offset}&length=${length}`,
						undefined,
						45_000,
					);
					if (response.status === 404)
						return yield* new HttpApiError.NotFound();
					if (response.status === 400)
						return yield* new HttpApiError.BadRequest();
					if (response.status !== 206)
						return yield* new HttpApiError.ServiceUnavailable();
					const range = response.headers.get("Content-Range") ?? "";
					const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(range);
					const total = Number(match?.[3]);
					if (
						!match ||
						Number(match[1]) !== offset ||
						Number(match[2]) !== offset + length - 1 ||
						!Number.isSafeInteger(total) ||
						total < offset + length ||
						total > 12 * 1024 * 1024 * 1024 ||
						response.headers.get("Content-Length") !== String(length) ||
						response.headers.get("Content-Type") !== "video/mp4"
					) {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					const data = yield* Effect.tryPromise({
						try: () => response.arrayBuffer(),
						catch: () => new HttpApiError.ServiceUnavailable(),
					});
					if (data.byteLength !== length)
						return yield* new HttpApiError.ServiceUnavailable();
					return HttpServerResponse.uint8Array(new Uint8Array(data), {
						status: 206,
						contentType: "video/mp4",
						headers: {
							"Content-Range": range,
							"Cache-Control": "private, no-store",
						},
					});
				}),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);

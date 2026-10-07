import { HttpAuthMiddleware } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import { apiToHandler } from "@/lib/server";
import { countRequestBodyBytes } from "@/lib/upload-health";

export const dynamic = "force-dynamic";

class Api extends HttpApi.make("CapUploadHealthApi").add(
	HttpApiGroup.make("root")
		.add(HttpApiEndpoint.get("status")`/api/desktop/upload-health`)
		.add(HttpApiEndpoint.post("probe")`/api/desktop/upload-health`)
		.middleware(HttpAuthMiddleware),
) {}

const jsonResponse = (body: unknown, status = 200) =>
	HttpServerResponse.text(JSON.stringify(body), {
		status,
		contentType: "application/json; charset=utf-8",
		headers: {
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("status", () => Effect.succeed(jsonResponse({ ok: true })))
				.handle("probe", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const body =
							request.source instanceof Request ? request.source.body : null;
						const { receivedBytes, truncated } = yield* Effect.tryPromise({
							try: () => countRequestBodyBytes(body),
							catch: () => new HttpApiError.InternalServerError(),
						});
						if (truncated) {
							return jsonResponse({ error: "probe_too_large" }, 413);
						}
						return jsonResponse({ receivedBytes });
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;

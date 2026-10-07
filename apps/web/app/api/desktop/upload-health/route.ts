import { randomUUID } from "node:crypto";
import { Storage } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import { apiToHandler } from "@/lib/server";
import { readUploadProbeBody } from "@/lib/upload-health";

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
						const probe = yield* Effect.tryPromise(() =>
							readUploadProbeBody(body),
						).pipe(Effect.catchAll(() => Effect.succeed(null)));
						if (!probe) {
							return jsonResponse({ error: "probe_read_failed" }, 400);
						}
						if (probe.truncated) {
							return jsonResponse({ error: "probe_too_large" }, 413);
						}

						const user = yield* CurrentUser;
						const storage = yield* Storage;
						const key = `.cap-upload-health-${randomUUID()}`;
						const uploaded = yield* storage
							.getWritableAccessForUser(
								user.id,
								user.activeOrganizationId,
							)
							.pipe(
								Effect.flatMap((writable) =>
									writable.access
										.putObject(key, probe.bytes, {
											contentType: "application/octet-stream",
											contentLength: probe.receivedBytes,
										})
										.pipe(
											Effect.ensuring(
												writable.access
													.deleteObject(key)
													.pipe(Effect.catchAll(() => Effect.void)),
											),
										),
								),
								Effect.as(true),
								Effect.catchAll(() => Effect.succeed(false)),
							);
						if (!uploaded) {
							return jsonResponse({ error: "storage_probe_failed" }, 503);
						}
						return jsonResponse({ receivedBytes: probe.receivedBytes });
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;

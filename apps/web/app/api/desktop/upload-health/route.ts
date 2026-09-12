import { HttpAuthMiddleware } from "@cap/web-domain";
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
import {
	MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
	readUploadHealthProbeBytes,
	UploadHealthProbeTooLargeError,
} from "./upload-health";

class Api extends HttpApi.make("DesktopUploadHealthApi").add(
	HttpApiGroup.make("root")
		.add(HttpApiEndpoint.head("check")`/api/desktop/upload-health`)
		.add(HttpApiEndpoint.post("probe")`/api/desktop/upload-health`)
		.middleware(HttpAuthMiddleware),
) {}

const probeTooLarge = () =>
	HttpServerResponse.unsafeJson({ error: "probe_too_large" }, { status: 413 });

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("check", () =>
					Effect.succeed(HttpServerResponse.empty({ status: 204 })),
				)
				.handle("probe", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const contentLength = Number(request.headers["content-length"]);

						if (
							Number.isFinite(contentLength) &&
							contentLength > MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES
						) {
							return probeTooLarge();
						}

						return yield* Effect.tryPromise({
							try: () => {
								if (!(request.source instanceof Request)) {
									throw new Error("Expected a Web Request");
								}
								return readUploadHealthProbeBytes(request.source);
							},
							catch: (error) => error,
						}).pipe(
							Effect.map((receivedBytes) =>
								HttpServerResponse.unsafeJson({
									success: true,
									receivedBytes,
									maxProbeBytes: MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
								}),
							),
							Effect.catchAll((error) => {
								if (error instanceof UploadHealthProbeTooLargeError) {
									return Effect.succeed(probeTooLarge());
								}
								return Effect.logError(
									"Failed to read upload health probe",
									error,
								).pipe(
									Effect.as(
										HttpServerResponse.unsafeJson(
											{ error: "probe_failed" },
											{ status: 500 },
										),
									),
								);
							}),
						);
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const HEAD = handler;
export const POST = handler;
export const OPTIONS = handler;

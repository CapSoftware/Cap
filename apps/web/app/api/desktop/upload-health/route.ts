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
	readUploadHealthProbe,
	UploadHealthProbeEmptyError,
	UploadHealthProbeTooLargeError,
} from "./upload-health";

class Api extends HttpApi.make("DesktopUploadHealthApi").add(
	HttpApiGroup.make("root")
		.add(HttpApiEndpoint.head("check")`/api/desktop/upload-health`)
		.add(HttpApiEndpoint.post("probe")`/api/desktop/upload-health`)
		.middleware(HttpAuthMiddleware),
) {}

const responseHeaders = { "Cache-Control": "private, no-store" };

const probeError = (error: string, status: number) =>
	HttpServerResponse.unsafeJson(
		{ error },
		{ status, headers: responseHeaders },
	);

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("check", () =>
					Effect.succeed(
						HttpServerResponse.empty({ status: 204, headers: responseHeaders }),
					),
				)
				.handle("probe", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const contentLength = Number(request.headers["content-length"]);

						if (
							Number.isFinite(contentLength) &&
							contentLength > MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES
						) {
							return probeError("probe_too_large", 413);
						}

						return yield* Effect.tryPromise({
							try: () => {
								if (!(request.source instanceof Request)) {
									throw new Error("Expected a Web Request");
								}
								return readUploadHealthProbe(request.source);
							},
							catch: (error) => error,
						}).pipe(
							Effect.map((probe) =>
								HttpServerResponse.unsafeJson(
									{
										success: true,
										...probe,
										maxProbeBytes: MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
									},
									{ headers: responseHeaders },
								),
							),
							Effect.catchAll((error) => {
								if (error instanceof UploadHealthProbeTooLargeError) {
									return Effect.succeed(probeError("probe_too_large", 413));
								}
								if (error instanceof UploadHealthProbeEmptyError) {
									return Effect.succeed(probeError("probe_empty", 400));
								}
								return Effect.logError(
									"Failed to read upload health probe",
									error,
								).pipe(Effect.as(probeError("probe_failed", 500)));
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

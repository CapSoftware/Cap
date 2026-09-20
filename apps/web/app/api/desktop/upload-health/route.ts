import { Desktop } from "@cap/web-domain";
import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { Effect, Layer, Stream } from "effect";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

const ApiLive = HttpApiBuilder.api(Desktop.DesktopApiContract).pipe(
	Layer.provide(
		HttpApiBuilder.group(Desktop.DesktopApiContract, "desktop", (handlers) =>
			handlers
				.handle("checkUploadHealth", () =>
					Effect.succeed({ ok: true as const }),
				)
				.handle("uploadHealthProbe", ({ request }) =>
					Effect.gen(function* () {
						const contentLength = Number(
							request.headers["content-length"] ?? 0,
						);
						if (contentLength > Desktop.MAX_UPLOAD_PROBE_BYTES) {
							return yield* new Desktop.UploadProbeTooLargeError({
								error: "Probe payload too large",
							});
						}

						const receivedBytes = yield* request.stream.pipe(
							Stream.runFoldWhile(
								0,
								(acc) => acc <= Desktop.MAX_UPLOAD_PROBE_BYTES,
								(acc, chunk) => acc + chunk.byteLength,
							),
							Effect.mapError(() => new HttpApiError.InternalServerError()),
						);
						if (receivedBytes > Desktop.MAX_UPLOAD_PROBE_BYTES) {
							return yield* new Desktop.UploadProbeTooLargeError({
								error: "Probe payload too large",
							});
						}

						return { receivedBytes };
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;

import { Storage } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
	HttpServerRequest,
} from "@effect/platform";
import { Effect, Layer, Schema, Stream } from "effect";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { apiToHandler } from "@/lib/server";
import {
	checkUploadStorage,
	MAX_UPLOAD_PROBE_BYTES,
	UploadProbeBody,
	UploadProbeLimiter,
	UploadProbeTooLarge,
} from "@/lib/upload-health";
import { getAccessibleOrganization } from "../[...route]/organizationStorage";

class ProbeTooLarge extends HttpApiSchema.EmptyError<ProbeTooLarge>()({
	tag: "ProbeTooLarge",
	status: 413,
}) {}

class ProbeRateLimited extends HttpApiSchema.EmptyError<ProbeRateLimited>()({
	tag: "ProbeRateLimited",
	status: 429,
}) {}

class Api extends HttpApi.make("DesktopUploadHealth").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("warm")`/api/desktop/upload-health`.addSuccess(
				Schema.Struct({ ok: Schema.Literal(true) }),
			),
		)
		.add(
			HttpApiEndpoint.post("probe")`/api/desktop/upload-health`
				.setUrlParams(
					Schema.Struct({
						checkStorage: Schema.optional(Schema.Literal("true")),
					}),
				)
				.addSuccess(
					Schema.Struct({ bytes: Schema.Number, bodyReadMs: Schema.Number }),
				)
				.addError(ProbeTooLarge)
				.addError(ProbeRateLimited)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.RequestTimeout),
		)
		.middleware(HttpAuthMiddleware),
) {}

const limiter = new UploadProbeLimiter();

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("warm", () => Effect.succeed({ ok: true as const }))
				.handle("probe", ({ urlParams }) =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						const request = yield* HttpServerRequest.HttpServerRequest;
						if (
							!limiter.admit(user.id) ||
							(yield* Effect.promise(() =>
								isRateLimited(RATE_LIMIT_IDS.DESKTOP_UPLOAD_HEALTH, {
									key: user.id,
									headers: new Headers(request.headers),
								}),
							))
						) {
							return yield* new ProbeRateLimited();
						}
						if (
							Number(request.headers["content-length"]) > MAX_UPLOAD_PROBE_BYTES
						) {
							return yield* new ProbeTooLarge();
						}
						const probe = new UploadProbeBody();
						yield* request.stream.pipe(
							Stream.runForEach((chunk) =>
								Effect.try({
									try: () => probe.append(chunk),
									catch: (error) =>
										error instanceof UploadProbeTooLarge
											? new ProbeTooLarge()
											: new HttpApiError.BadRequest(),
								}),
							),
							Effect.catchTag(
								"RequestError",
								() => new HttpApiError.BadRequest(),
							),
						);
						const result = probe.result();
						if (!result.bytes) return yield* new HttpApiError.BadRequest();
						if (urlParams.checkStorage) {
							if (user.activeOrganizationId) {
								const organization = yield* Effect.tryPromise({
									try: () =>
										getAccessibleOrganization(
											user.id,
											user.activeOrganizationId,
										),
									catch: () => new HttpApiError.ServiceUnavailable(),
								});
								if (!organization) return yield* new HttpApiError.Forbidden();
							}
							const storage = yield* Storage;
							const { access } = yield* storage
								.getWritableAccessForUser(user.id, user.activeOrganizationId)
								.pipe(
									Effect.mapError(() => new HttpApiError.ServiceUnavailable()),
								);
							yield* checkUploadStorage({
								userId: user.id,
								bytes: probe.sample(),
								put: (key, bytes) =>
									access.putObject(key, Buffer.from(bytes), {
										contentType: "application/octet-stream",
									}),
								remove: (key) => access.deleteObject(key),
								onCleanupFailure: () =>
									console.warn("Upload-health probe cleanup failed"),
							}).pipe(
								Effect.mapError(() => new HttpApiError.ServiceUnavailable()),
							);
						}
						return result;
					}).pipe(
						Effect.timeoutFail({
							duration: "25 seconds",
							onTimeout: () => new HttpApiError.RequestTimeout(),
						}),
					),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
export const maxDuration = 30;

import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware, Organisation } from "@cap/web-domain";
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
import { getDesktopRecordingOrganization } from "@/lib/desktop-recording-organization";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { apiToHandler } from "@/lib/server";
import {
	checkUploadStorage,
	MAX_UPLOAD_PROBE_BYTES,
	UploadProbeBody,
	UploadProbeLimiter,
	UploadProbeTooLarge,
} from "@/lib/upload-health";

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
						orgId: Schema.optional(Organisation.OrganisationId),
					}),
				)
				.addSuccess(
					Schema.Struct({
						bytes: Schema.Number,
						bodyReadMs: Schema.Number,
						organizationId: Organisation.OrganisationId,
					}),
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
						const apiKey = request.headers.authorization?.split(" ")[1];
						if (apiKey?.length !== 36) {
							const site = request.headers["sec-fetch-site"];
							if (
								site !== undefined
									? site !== "same-origin"
									: request.headers.origin !==
										new URL(serverEnv().WEB_URL).origin
							) {
								return yield* new HttpApiError.Forbidden();
							}
						}
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
						const organizationId = yield* Effect.tryPromise({
							try: () =>
								getDesktopRecordingOrganization(user.id, urlParams.orgId),
							catch: () => new HttpApiError.ServiceUnavailable(),
						});
						if (!organizationId)
							return yield* new HttpApiError.ServiceUnavailable();
						if (urlParams.checkStorage) {
							const storage = yield* Storage;
							const { access } = yield* storage
								.getWritableAccessForUser(user.id, organizationId)
								.pipe(
									Effect.mapError(() => new HttpApiError.ServiceUnavailable()),
								);
							yield* checkUploadStorage({
								userId: user.id,
								bytes: probe.sample(),
								put: (key, bytes) =>
									access.putProbeObject(key, Buffer.from(bytes)),
								remove: (key) => access.deleteObject(key),
								onCleanupFailure: () =>
									console.warn("Upload-health probe cleanup failed"),
							}).pipe(
								Effect.mapError(() => new HttpApiError.ServiceUnavailable()),
							);
						}
						return { ...result, organizationId };
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

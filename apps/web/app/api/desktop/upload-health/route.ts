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

class ProbeTooLarge extends Schema.TaggedError<ProbeTooLarge>()(
	"ProbeTooLarge",
	{},
	HttpApiSchema.annotations({ status: 413 }),
) {}

class ProbeRateLimited extends Schema.TaggedError<ProbeRateLimited>()(
	"ProbeRateLimited",
	{},
	HttpApiSchema.annotations({ status: 429 }),
) {}

class Api extends HttpApi.make("DesktopUploadHealth").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("warm", "/api/desktop/upload-health").addSuccess(
				Schema.Struct({ ok: Schema.Literal(true) }),
			),
		)
		.add(
			HttpApiEndpoint.post("probe", "/api/desktop/upload-health")
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
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Forbidden)
				.addError(ProbeTooLarge)
				.addError(ProbeRateLimited)
				.addError(HttpApiError.RequestTimeout)
				.addError(HttpApiError.ServiceUnavailable),
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
						const storage = yield* Storage;
						const request = yield* HttpServerRequest.HttpServerRequest;

						if (request.headers.authorization?.split(" ")[1]?.length !== 36) {
							const fetchSite = request.headers["sec-fetch-site"];
							const sameOrigin = fetchSite
								? fetchSite === "same-origin"
								: request.headers.origin ===
									new URL(serverEnv().WEB_URL).origin;
							if (!sameOrigin) return yield* new HttpApiError.Forbidden();
						}

						if (
							!limiter.admit(user.id) ||
							(yield* Effect.promise(() =>
								isRateLimited(RATE_LIMIT_IDS.DESKTOP_UPLOAD_HEALTH, {
									key: user.id,
									headers: new Headers(
										request.headers as Record<string, string>,
									),
								}),
							))
						)
							return yield* new ProbeRateLimited();

						const declared = Number(request.headers["content-length"]);
						if (
							Number.isFinite(declared) &&
							declared > MAX_UPLOAD_PROBE_BYTES
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
							Effect.catchTag("RequestError", () =>
								Effect.fail(new HttpApiError.BadRequest()),
							),
						);

						const result = probe.result();
						if (!result.bytes) return yield* new HttpApiError.BadRequest();

						const organizationId = yield* Effect.tryPromise({
							try: () =>
								getDesktopRecordingOrganization(user.id, urlParams.orgId),
							catch: () => new HttpApiError.ServiceUnavailable(),
						}).pipe(
							Effect.flatMap((id) =>
								id
									? Effect.succeed(id)
									: Effect.fail(new HttpApiError.ServiceUnavailable()),
							),
						);

						if (urlParams.checkStorage === "true") {
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
								onCleanupFailure: (error) => {
									console.warn("Upload health probe cleanup failed", error);
								},
							}).pipe(
								Effect.mapError(() => new HttpApiError.ServiceUnavailable()),
							);
						}

						return {
							bytes: result.bytes,
							bodyReadMs: result.bodyReadMs,
							organizationId,
						};
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

export const GET = (req: Request) => handler(req);
export const POST = (req: Request) => handler(req);

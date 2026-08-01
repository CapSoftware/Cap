import {
	createProductEventRows,
	PRODUCT_ANALYTICS_LIMITS,
} from "@cap/analytics";
import { serverEnv } from "@cap/env";
import {
	hasAnalyticsSessionCookie,
	ProductAnalytics,
	resolveProductAnalyticsActor,
} from "@cap/web-backend";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
	HttpServerRequest,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import UAParser from "ua-parser-js";
import {
	readProductAnalyticsBrowserToken,
	readProductAnalyticsBrowserTokenClaims,
} from "@/lib/analytics/browser-token";
import {
	classifyAnalyticsTraffic,
	getProductAnalyticsRateLimitKey,
	hasExpectedBrowserAnalyticsMetadata,
	isAllowedAnonymousBrowserProductEvent,
	isAuthenticatedAnalyticsRequestCandidate,
	normalizeAnalyticsHostname,
	normalizeGeoHeader,
	normalizeProductEventBatch,
	normalizeSyntheticRunId,
	ProductAnalyticsRateLimiter,
	shouldRejectUnresolvedAuthenticatedAnalyticsRequest,
} from "@/lib/analytics/request";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { apiToHandler } from "@/lib/server";
import { allowedOrigins } from "@/utils/cors";

class RateLimited extends Schema.TaggedError<RateLimited>()(
	"RateLimited",
	{},
	HttpApiSchema.annotations({ status: 429 }),
) {}

const DeliveryCount = Schema.Number.pipe(
	Schema.int(),
	Schema.greaterThanOrEqualTo(0),
	Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

class Api extends HttpApi.make("ProductAnalyticsApi").add(
	HttpApiGroup.make("events").add(
		HttpApiEndpoint.post("capture", "/api/events")
			.setPayload(
				Schema.Struct({
					events: Schema.Array(Schema.Unknown).pipe(
						Schema.minItems(1),
						Schema.maxItems(PRODUCT_ANALYTICS_LIMITS.batchSize),
					),
					delivery: Schema.optional(
						Schema.Struct({
							attempted: DeliveryCount,
							accepted: DeliveryCount,
							retried: DeliveryCount,
							dropped: DeliveryCount,
							queue_overflow: DeliveryCount,
							oversize: DeliveryCount,
							contract_rejected: Schema.optional(DeliveryCount),
							persistence_failed: Schema.optional(DeliveryCount),
						}),
					),
				}),
			)
			.addSuccess(Schema.Struct({ accepted: Schema.Number }))
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.ServiceUnavailable)
			.addError(RateLimited),
	),
) {}

const RequestHeaders = Schema.Struct({
	authorization: Schema.optional(Schema.String),
	"content-length": Schema.optional(Schema.String),
	cookie: Schema.optional(Schema.String),
	"sec-fetch-site": Schema.optional(Schema.String),
	origin: Schema.optional(Schema.String),
	"x-vercel-ip-country": Schema.optional(Schema.String),
	"x-vercel-ip-country-region": Schema.optional(Schema.String),
	"x-vercel-ip-city": Schema.optional(Schema.String),
	"x-vercel-forwarded-for": Schema.optional(Schema.String),
	"x-forwarded-for": Schema.optional(Schema.String),
	"user-agent": Schema.optional(Schema.String),
	"x-cap-analytics-test-run": Schema.optional(Schema.String),
});

const fallbackRateLimiter = new ProductAnalyticsRateLimiter();

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "events", (handlers) =>
			Effect.gen(function* () {
				const analytics = yield* ProductAnalytics;
				const environment = serverEnv();

				return handlers.handle("capture", ({ payload }) =>
					Effect.gen(function* () {
						const headers = yield* HttpServerRequest.schemaHeaders(
							RequestHeaders,
						).pipe(Effect.mapError(() => new HttpApiError.BadRequest()));
						const requestMetadata = {
							authorization: headers.authorization,
							contentLength: headers["content-length"],
							origin: headers.origin,
							secFetchSite: headers["sec-fetch-site"],
						};
						const browserClaims =
							hasExpectedBrowserAnalyticsMetadata(
								requestMetadata,
								allowedOrigins,
							) &&
							readProductAnalyticsBrowserTokenClaims(
								readProductAnalyticsBrowserToken(headers.cookie),
								environment.NEXTAUTH_SECRET,
							);
						if (
							!browserClaims &&
							!isAuthenticatedAnalyticsRequestCandidate(requestMetadata)
						) {
							return yield* Effect.fail(new HttpApiError.BadRequest());
						}

						const isVercel = process.env.VERCEL === "1";
						const trustedNetworkProxy =
							isVercel || process.env.CAP_ANALYTICS_TRUST_PROXY === "1";
						if (!trustedNetworkProxy) {
							return yield* Effect.fail(new HttpApiError.ServiceUnavailable());
						}
						const rateLimitKey = getProductAnalyticsRateLimitKey({
							trustedNetworkProxy,
							forwardedFor:
								headers[
									isVercel ? "x-vercel-forwarded-for" : "x-forwarded-for"
								],
						});
						if (!rateLimitKey) {
							return yield* Effect.fail(new HttpApiError.BadRequest());
						}
						if (fallbackRateLimiter.isRateLimited(rateLimitKey)) {
							return yield* Effect.fail(new RateLimited());
						}

						const firewallLimited = yield* Effect.promise(() =>
							Promise.all([
								isRateLimited(RATE_LIMIT_IDS.PRODUCT_ANALYTICS_EVENTS),
								...(browserClaims
									? [
											isRateLimited(RATE_LIMIT_IDS.PRODUCT_ANALYTICS_EVENTS, {
												key: `browser:${browserClaims.anonymousId}`,
											}),
										]
									: []),
							]),
						);
						if (firewallLimited.some(Boolean)) {
							return yield* Effect.fail(new RateLimited());
						}

						const events = normalizeProductEventBatch(payload.events);
						if (!events) {
							return yield* Effect.fail(new HttpApiError.BadRequest());
						}

						const actor = yield* resolveProductAnalyticsActor;
						if (
							shouldRejectUnresolvedAuthenticatedAnalyticsRequest({
								actorResolved: Boolean(actor),
								authorizationCandidate:
									isAuthenticatedAnalyticsRequestCandidate(requestMetadata),
								hasSessionCookie: hasAnalyticsSessionCookie(headers.cookie),
							})
						) {
							return yield* Effect.fail(new HttpApiError.BadRequest());
						}
						if (
							!actor &&
							(!browserClaims ||
								!events.every((event) =>
									isAllowedAnonymousBrowserProductEvent(
										event,
										browserClaims.anonymousId,
									),
								))
						) {
							return yield* Effect.fail(new HttpApiError.BadRequest());
						}
						const syntheticRunId = normalizeSyntheticRunId(
							headers["x-cap-analytics-test-run"],
							environment.VERCEL_ENV,
						);
						const userAgent = headers["user-agent"] ?? "";
						const parsedUserAgent = new UAParser(userAgent);
						const rows = createProductEventRows(events, {
							receivedAt: new Date().toISOString(),
							source: "client",
							userId: actor?.userId,
							organizationId: actor?.organizationId,
							country: normalizeGeoHeader(headers["x-vercel-ip-country"]),
							region: normalizeGeoHeader(headers["x-vercel-ip-country-region"]),
							city: normalizeGeoHeader(headers["x-vercel-ip-city"], true),
							hostname: normalizeAnalyticsHostname(headers.origin),
							browser: parsedUserAgent.getBrowser().name ?? "unknown",
							device: parsedUserAgent.getDevice().type ?? "desktop",
							os: parsedUserAgent.getOS().name ?? "unknown",
							trafficClass: classifyAnalyticsTraffic({
								userAgent,
								vercelEnvironment: environment.VERCEL_ENV,
								syntheticRunId,
								rateLimitKey,
								internalIpHashes:
									process.env.PRODUCT_ANALYTICS_INTERNAL_IP_HASHES,
							}),
							syntheticRunId,
						});

						yield* analytics
							.appendWithIdentityFence(rows)
							.pipe(
								Effect.catchAll((error) =>
									Effect.logWarning("Product analytics ingestion failed").pipe(
										Effect.zipRight(
											Effect.fail(
												"retryable" in error && error.retryable === false
													? new HttpApiError.BadRequest()
													: new HttpApiError.ServiceUnavailable(),
											),
										),
									),
								),
							);
						if (payload.delivery) {
							yield* Effect.logInfo("Product analytics client delivery", {
								platform: rows[0]?.platform ?? "unknown",
								appVersion: rows[0]?.app_version ?? "",
								...payload.delivery,
							});
						}

						return { accepted: rows.length };
					}),
				);
			}),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
export const OPTIONS = handler;

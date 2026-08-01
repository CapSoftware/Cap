import { createHash, timingSafeEqual } from "node:crypto";
import { Tinybird } from "@cap/web-backend";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import type Stripe from "stripe";
import { queueServerProductEvent } from "@/lib/analytics/server";
import type { ServerProductEvent } from "@/lib/analytics/server-event";
import { subscriptionCheckoutProductEvent } from "@/lib/analytics/stripe-business-events";
import { apiToHandler } from "@/lib/server";

class Api extends HttpApi.make("AnalyticsStagingTestApi").add(
	HttpApiGroup.make("stagingTest")
		.add(
			HttpApiEndpoint.post("run", "/api/analytics/staging-test")
				.setPayload(
					Schema.Struct({
						scenario: Schema.Literal("business_lifecycle"),
						runId: Schema.String,
						sha: Schema.String,
					}),
				)
				.addSuccess(
					Schema.Struct({
						accepted: Schema.Number,
						uniqueEvents: Schema.Number,
						workflowRuns: Schema.Array(Schema.String),
					}),
				)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Unauthorized)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.ServiceUnavailable),
		)
		.add(
			HttpApiEndpoint.post("erase", "/api/analytics/staging-test/erase")
				.setPayload(
					Schema.Struct({
						runId: Schema.String,
						sha: Schema.String,
					}),
				)
				.addSuccess(Schema.Struct({ erased: Schema.Boolean }))
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Unauthorized)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.ServiceUnavailable),
		),
) {}

const RequestHeaders = Schema.Struct({
	authorization: Schema.optional(Schema.String),
});

const safeEqual = (actual: string | undefined, expected: string) =>
	Boolean(
		actual &&
			actual.length === expected.length &&
			timingSafeEqual(Buffer.from(actual), Buffer.from(expected)),
	);

const boundedRunId = (value: string) =>
	/^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : undefined;

const draftSha = (value: string) => /^[0-9a-f]{40}$/.test(value);

const authorize = (payload: { runId: string; sha: string }) =>
	Effect.gen(function* () {
		if (process.env.VERCEL_ENV !== "preview") {
			return yield* Effect.fail(new HttpApiError.NotFound());
		}
		const secret = process.env.CAP_ANALYTICS_STAGING_TEST_SECRET;
		if (!secret) {
			return yield* Effect.fail(new HttpApiError.ServiceUnavailable());
		}
		const headers = yield* HttpServerRequest.schemaHeaders(RequestHeaders).pipe(
			Effect.mapError(() => new HttpApiError.BadRequest()),
		);
		if (!safeEqual(headers.authorization, `Bearer ${secret}`)) {
			return yield* Effect.fail(new HttpApiError.Unauthorized());
		}
		const runId = boundedRunId(payload.runId);
		if (
			!runId ||
			!draftSha(payload.sha) ||
			payload.sha !== process.env.VERCEL_GIT_COMMIT_SHA
		) {
			return yield* Effect.fail(new HttpApiError.BadRequest());
		}
		return runId;
	});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "stagingTest", (handlers) =>
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				return handlers
					.handle("run", ({ payload }) =>
						Effect.gen(function* () {
							const runId = yield* authorize(payload);
							const hash = createHash("sha256").update(runId).digest("hex");
							const occurredAt = new Date().toISOString();
							const userId = `staging_user_${hash.slice(0, 20)}`;
							const organizationId = `staging_org_${hash.slice(20, 40)}`;
							const anonymousId = `staging_anon_${hash.slice(40, 60)}`;
							const purchase = subscriptionCheckoutProductEvent({
								eventId: `staging_${hash.slice(0, 24)}`,
								occurredAt,
								session: {
									amount_subtotal: 2_500,
									amount_total: 2_500,
									currency: "usd",
									metadata: {
										analyticsAnonymousId: anonymousId,
										analyticsIsFirstPurchase: "true",
										analyticsOrganizationId: organizationId,
										analyticsPriceId: "price_staging_annual",
										analyticsQuantity: "1",
										analyticsSchemaVersion: "1",
										isOnBoarding: "false",
										platform: "web",
									},
									payment_status: "paid",
									total_details: { amount_discount: 0 },
								} as unknown as Stripe.Checkout.Session,
								user: { id: userId },
							});
							if (!purchase) {
								return yield* Effect.fail(
									new HttpApiError.ServiceUnavailable(),
								);
							}
							const events: ServerProductEvent[] = [
								{
									_syntheticRunId: runId,
									anonymousId,
									eventId: `staging_signup_${hash.slice(0, 24)}`,
									eventName: "user_signed_up",
									occurredAt,
									organizationId,
									platform: "web",
									userId,
								},
								{
									_syntheticRunId: runId,
									anonymousId,
									eventId: `staging_share_${hash.slice(0, 24)}`,
									eventName: "share_link_created",
									occurredAt,
									organizationId,
									platform: "server",
									properties: {
										asset_type: "recording",
										recording_mode: "screen",
									},
									userId,
								},
								{
									_syntheticRunId: runId,
									anonymousId,
									eventId: `staging_checkout_${hash.slice(0, 24)}`,
									eventName: "checkout_started",
									occurredAt,
									organizationId,
									platform: "web",
									properties: {
										is_onboarding: false,
										price_id: "price_staging_annual",
										quantity: 1,
									},
									userId,
								},
								{ ...purchase, _syntheticRunId: runId },
								{ ...purchase, _syntheticRunId: runId },
							];
							const workflowRuns = yield* Effect.tryPromise({
								try: () => Promise.all(events.map(queueServerProductEvent)),
								catch: () => new HttpApiError.ServiceUnavailable(),
							});
							return {
								accepted: events.length,
								uniqueEvents: new Set(events.map((event) => event.eventId))
									.size,
								workflowRuns: workflowRuns.map(({ runId: id }) => id),
							};
						}),
					)
					.handle("erase", ({ payload }) =>
						Effect.gen(function* () {
							const runId = yield* authorize(payload);
							const hash = createHash("sha256").update(runId).digest("hex");
							yield* tinybird
								.eraseProductAnalytics({
									userId: `synthetic_user_${hash.slice(0, 24)}`,
									organizationId: `synthetic_org_${hash.slice(24, 48)}`,
								})
								.pipe(
									Effect.mapError(() => new HttpApiError.ServiceUnavailable()),
								);
							return { erased: true };
						}),
					);
			}),
		),
	),
);

const handler = apiToHandler(ApiLive);
export const POST = handler;

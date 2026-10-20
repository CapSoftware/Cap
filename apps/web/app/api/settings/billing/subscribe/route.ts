import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { stripe, userIsPro } from "@cap/utils";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import type Stripe from "stripe";
import {
	CheckoutCurrencyUnavailable,
	checkoutCurrencyForChoice,
	proCheckoutPeriod,
	proCheckoutStepUrl,
} from "@/lib/pro-checkout-currency";
import { apiToHandler } from "@/lib/server";
import { trackServerEvent } from "@/lib/server-analytics";

class Api extends HttpApi.make("CapSubscribeApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("subscribe")`/api/settings/billing/subscribe`,
	),
) {}

const jsonResponse = (body: unknown, status = 200) =>
	HttpServerResponse.unsafeJson(body, { status });

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("subscribe", () =>
				Effect.gen(function* () {
					const user = yield* Effect.tryPromise(getCurrentUser);
					let customerId = user?.stripeCustomerId;
					const request = yield* HttpServerRequest.HttpServerRequest;
					const body = (yield* request.json) as Record<string, unknown>;
					const { priceId, quantity } = body;
					const isOnBoarding = body.isOnBoarding === true;
					const continueCheckout = body.continueCheckout === true;

					if (typeof priceId !== "string" || !priceId) {
						console.error("Price ID not found");
						return jsonResponse({ error: true }, 400);
					}
					if (
						typeof quantity !== "number" ||
						!Number.isSafeInteger(quantity) ||
						quantity < 1
					) {
						return jsonResponse(
							{ error: true, message: "Choose at least one user." },
							400,
						);
					}

					if (!user) {
						console.error("User not found");
						return jsonResponse({ error: true, auth: false }, 401);
					}

					if (userIsPro(user)) {
						console.error("User already has pro plan");
						return jsonResponse({ error: true, subscription: true }, 400);
					}
					const period = proCheckoutPeriod(priceId);
					if (continueCheckout && !period) {
						return jsonResponse({ error: true }, 400);
					}
					if (period && !continueCheckout) {
						const url = proCheckoutStepUrl({
							baseUrl: serverEnv().WEB_URL,
							priceId,
							quantity,
							flow: "account",
							isOnBoarding,
						});
						if (!url) return jsonResponse({ error: true }, 400);
						return jsonResponse({ url });
					}

					const checkoutCurrency = continueCheckout
						? yield* Effect.tryPromise(() =>
								checkoutCurrencyForChoice(priceId, body.checkoutCurrency),
							)
						: undefined;
					if (!user.stripeCustomerId) {
						const existingCustomers = yield* Effect.tryPromise(() =>
							stripe().customers.list({
								email: user.email,
								limit: 1,
							}),
						);

						let customer: Stripe.Customer;
						if (
							existingCustomers.data.length > 0 &&
							existingCustomers.data[0]
						) {
							customer = existingCustomers.data[0];

							customer = yield* Effect.tryPromise(() =>
								stripe().customers.update(customer.id, {
									metadata: {
										...customer.metadata,
										userId: user.id,
									},
								}),
							);
						} else {
							customer = yield* Effect.tryPromise(() =>
								stripe().customers.create({
									email: user.email,
									metadata: {
										userId: user.id,
									},
								}),
							);
						}

						yield* Effect.tryPromise(async () => {
							await db()
								.update(users)
								.set({ stripeCustomerId: customer.id })
								.where(eq(users.id, user.id));
						});
						customerId = customer.id;
					}

					const checkoutSession = yield* Effect.tryPromise(() =>
						stripe().checkout.sessions.create({
							customer: customerId as string,
							line_items: [{ price: priceId, quantity }],
							mode: "subscription",
							...(checkoutCurrency
								? {
										currency: checkoutCurrency,
										adaptive_pricing: { enabled: false },
									}
								: {}),
							success_url: isOnBoarding
								? `${serverEnv().WEB_URL}/dashboard/settings/organization?upgrade=true&session_id={CHECKOUT_SESSION_ID}`
								: `${serverEnv().WEB_URL}/dashboard/caps?upgrade=true&session_id={CHECKOUT_SESSION_ID}`,
							cancel_url: isOnBoarding
								? `${serverEnv().WEB_URL}/onboarding`
								: `${serverEnv().WEB_URL}/pricing`,
							allow_promotion_codes: true,
							metadata: {
								platform: "web",
								dubCustomerId: user.id,
								isOnBoarding: isOnBoarding ? "true" : "false",
							},
						}),
					);

					if (checkoutSession.url) {
						yield* Effect.try(() =>
							trackServerEvent(user.id, "checkout_started", {
								price_id: priceId,
								quantity,
								platform: "web",
							}),
						);

						return jsonResponse({ url: checkoutSession.url });
					}

					console.error("Checkout session created but no URL returned");
					return jsonResponse({ error: true }, 400);
				}).pipe(
					Effect.catchAll((error) => {
						const cause = error.cause ?? error;
						if (cause instanceof CheckoutCurrencyUnavailable) {
							return Effect.succeed(
								jsonResponse({ error: true, message: cause.message }, 400),
							);
						}
						console.error("Error creating checkout session:", cause);
						return Effect.succeed(jsonResponse({ error: true }, 500));
					}),
				),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;

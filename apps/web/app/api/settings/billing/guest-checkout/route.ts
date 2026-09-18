import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import { getCheckoutRedirectUrls } from "@/lib/mobile-checkout";
import {
	CheckoutCurrencyUnavailable,
	checkoutCurrencyForChoice,
	proCheckoutPeriod,
	proCheckoutStepUrl,
} from "@/lib/pro-checkout-currency";
import { apiToHandler } from "@/lib/server";
import { trackServerEvent } from "@/lib/server-analytics";

class Api extends HttpApi.make("CapGuestCheckoutApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post(
			"startGuestCheckout",
		)`/api/settings/billing/guest-checkout`,
	),
) {}

const jsonResponse = (body: unknown, status = 200) =>
	HttpServerResponse.unsafeJson(body, { status });

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("startGuestCheckout", () =>
				Effect.gen(function* () {
					console.log("Starting guest checkout process");
					const request = yield* HttpServerRequest.HttpServerRequest;
					const body = (yield* request.json) as Record<string, unknown>;
					const { priceId } = body;
					const quantity =
						body.quantity === undefined ? 1 : Number(body.quantity);
					const platform = body.platform;
					const continueCheckout = body.continueCheckout === true;
					const checkoutPlatform = platform === "mobile" ? "mobile" : "web";

					console.log("Received guest checkout request:", {
						priceId,
						quantity,
					});

					if (typeof priceId !== "string" || !priceId) {
						console.error("Missing required priceId");
						return jsonResponse({ error: "priceId is required" }, 400);
					}
					if (!Number.isSafeInteger(quantity) || quantity < 1) {
						return jsonResponse({ error: "Choose at least one user." }, 400);
					}
					const period = proCheckoutPeriod(priceId);
					if (continueCheckout && (checkoutPlatform !== "web" || !period)) {
						return jsonResponse({ error: "Invalid checkout plan." }, 400);
					}
					if (period && checkoutPlatform === "web" && !continueCheckout) {
						const url = proCheckoutStepUrl({
							baseUrl: serverEnv().WEB_URL,
							priceId,
							quantity,
							flow: "guest",
						});
						if (!url) return jsonResponse({ error: true }, 400);
						return jsonResponse({ url });
					}

					console.log("Creating guest checkout session");
					const checkoutCurrency = continueCheckout
						? yield* Effect.tryPromise(() =>
								checkoutCurrencyForChoice(priceId, body.checkoutCurrency),
							)
						: undefined;
					const redirects = getCheckoutRedirectUrls(
						checkoutPlatform,
						serverEnv().WEB_URL,
					);
					const checkoutSession = yield* Effect.tryPromise(() =>
						stripe().checkout.sessions.create({
							line_items: [{ price: priceId, quantity }],
							mode: "subscription",
							...(checkoutCurrency ? { currency: checkoutCurrency } : {}),
							success_url: redirects.successUrl,
							cancel_url: redirects.cancelUrl,
							allow_promotion_codes: true,
							metadata: {
								platform: checkoutPlatform,
								guestCheckout: "true",
							},
						}),
					);

					if (checkoutSession.url) {
						console.log("Successfully created guest checkout session");

						yield* Effect.try(() =>
							trackServerEvent(
								`guest-${checkoutSession.id}`,
								"guest_checkout_started",
								{
									price_id: priceId,
									quantity,
									platform: checkoutPlatform,
									session_id: checkoutSession.id,
								},
							),
						);

						return jsonResponse({ url: checkoutSession.url });
					}

					console.error("Checkout session created but no URL returned");
					return jsonResponse(
						{ error: "Failed to create checkout session" },
						400,
					);
				}).pipe(
					Effect.catchAll((error) => {
						const cause = error.cause ?? error;
						if (cause instanceof CheckoutCurrencyUnavailable) {
							return Effect.succeed(
								jsonResponse({ error: true, message: cause.message }, 400),
							);
						}
						console.error("Error creating guest checkout session:", cause);
						return Effect.succeed(
							jsonResponse({ error: "Internal server error" }, 500),
						);
					}),
				),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;

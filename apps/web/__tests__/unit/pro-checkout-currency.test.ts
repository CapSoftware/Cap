import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import CheckoutPage from "@/app/(site)/checkout/page";
import { POST as guestCheckout } from "@/app/api/settings/billing/guest-checkout/route";
import { POST as accountCheckout } from "@/app/api/settings/billing/subscribe/route";
import {
	CheckoutCurrencyPicker,
	checkoutSignInHref,
} from "@/components/checkout-currency-picker";

const mocks = vi.hoisted(() => ({
	createSession: vi.fn(),
	retrievePrice: vi.fn(),
	currentUser: vi.fn(),
	trackEvent: vi.fn(),
	listCustomers: vi.fn(),
	createCustomer: vi.fn(),
	updateCustomer: vi.fn(),
	writeCustomerId: vi.fn(),
	disposeHandlers: [] as Array<() => Promise<void>>,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		update: () => ({
			set: () => ({
				where: mocks.writeCustomerId,
			}),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.currentUser,
}));
vi.mock("@cap/database/schema", () => ({ users: { id: "id" } }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("@cap/utils", () => ({
	STRIPE_PLAN_IDS: {
		development: { monthly: "price_monthly", yearly: "price_yearly" },
		production: { monthly: "price_live_monthly", yearly: "price_live_yearly" },
	},
	stripe: () => ({
		prices: { retrieve: mocks.retrievePrice },
		checkout: { sessions: { create: mocks.createSession } },
		customers: {
			list: mocks.listCustomers,
			create: mocks.createCustomer,
			update: mocks.updateCustomer,
		},
	}),
	userIsPro: () => false,
}));
vi.mock("@/lib/server-analytics", () => ({
	trackServerEvent: mocks.trackEvent,
}));
vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (
			api: import("effect").Layer.Layer<
				import("@effect/platform").HttpApi.Api,
				never,
				never
			>,
		) => {
			const handler = api.pipe(
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.disposeHandlers.push(handler.dispose);
			return handler.handler;
		},
	};
});

const checkoutRequest = (route: string, body: Record<string, unknown>) =>
	new Request(`https://cap.test${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

describe("Cap Pro checkout currency", () => {
	afterAll(() =>
		Promise.all(mocks.disposeHandlers.map((dispose) => dispose())),
	);

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.VERCEL_ENV = "preview";
		mocks.currentUser.mockResolvedValue({
			id: "test-user",
			email: "",
			stripeCustomerId: "cus_test",
		});
		mocks.listCustomers.mockResolvedValue({ data: [] });
		mocks.createCustomer.mockResolvedValue({ id: "cus_new" });
		mocks.writeCustomerId.mockResolvedValue(undefined);
		mocks.createSession.mockResolvedValue({
			id: "cs_test",
			url: "https://checkout.stripe.test/session",
		});
		mocks.retrievePrice.mockImplementation(async (priceId: string) => ({
			active: true,
			currency: "usd",
			currency_options:
				priceId === "price_monthly"
					? { usd: {}, gbp: {}, eur: {} }
					: { usd: {} },
		}));
	});

	it("sends account and guest buyers to the currency step before starting Stripe", async () => {
		const account = await accountCheckout(
			checkoutRequest("/api/settings/billing/subscribe", {
				priceId: "price_monthly",
				quantity: 2,
				isOnBoarding: true,
			}),
		);
		const guest = await guestCheckout(
			checkoutRequest("/api/settings/billing/guest-checkout", {
				priceId: "price_monthly",
				quantity: 1,
			}),
		);
		const accountUrl = new URL((await account.json()).url);
		const guestUrl = new URL((await guest.json()).url);
		expect(accountUrl.pathname).toBe("/checkout");
		expect(accountUrl.searchParams.get("flow")).toBe("account");
		expect(accountUrl.searchParams.get("isOnBoarding")).toBe("true");
		expect(guestUrl.searchParams.get("flow")).toBe("guest");
		expect(mocks.createSession).not.toHaveBeenCalled();
		expect(mocks.retrievePrice).not.toHaveBeenCalled();
	});

	it("charges an account buyer in USD even when automatic checkout might localize", async () => {
		const response = await accountCheckout(
			checkoutRequest("/api/settings/billing/subscribe", {
				priceId: "price_monthly",
				quantity: 2,
				continueCheckout: true,
				checkoutCurrency: "usd",
			}),
		);
		expect(response.status).toBe(200);
		expect(mocks.createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				customer: "cus_test",
				currency: "usd",
				line_items: [{ price: "price_monthly", quantity: 2 }],
			}),
		);
	});

	it("creates an account customer before starting checkout when needed", async () => {
		mocks.currentUser.mockResolvedValue({
			id: "test-user",
			email: "",
			stripeCustomerId: null,
		});
		const response = await accountCheckout(
			checkoutRequest("/api/settings/billing/subscribe", {
				priceId: "price_monthly",
				quantity: 2,
				continueCheckout: true,
				checkoutCurrency: "usd",
			}),
		);
		expect(response.status).toBe(200);
		expect(mocks.listCustomers).toHaveBeenCalledWith({
			email: "",
			limit: 1,
		});
		expect(mocks.createCustomer).toHaveBeenCalledWith({
			email: "",
			metadata: { userId: "test-user" },
		});
		expect(mocks.writeCustomerId).toHaveBeenCalledOnce();
		expect(mocks.createSession).toHaveBeenCalledWith(
			expect.objectContaining({ customer: "cus_new", currency: "usd" }),
		);
	});

	it("keeps the existing error response if Stripe cannot start checkout", async () => {
		mocks.createSession.mockRejectedValue(new Error("Stripe unavailable"));
		const response = await accountCheckout(
			checkoutRequest("/api/settings/billing/subscribe", {
				priceId: "price_monthly",
				quantity: 1,
				continueCheckout: true,
				checkoutCurrency: "auto",
			}),
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: true });
	});

	it("honors a guest choice and leaves automatic currency to Stripe", async () => {
		const route = "/api/settings/billing/guest-checkout";
		await guestCheckout(
			checkoutRequest(route, {
				priceId: "price_monthly",
				quantity: 1,
				continueCheckout: true,
				checkoutCurrency: "eur",
			}),
		);
		expect(mocks.createSession).toHaveBeenLastCalledWith(
			expect.objectContaining({ currency: "eur" }),
		);
		await guestCheckout(
			checkoutRequest(route, {
				priceId: "price_monthly",
				quantity: 1,
				continueCheckout: true,
				checkoutCurrency: "auto",
			}),
		);
		const latest = mocks.createSession.mock.calls.at(-1)?.[0];
		expect(latest).not.toHaveProperty("currency");
	});

	it("rejects a currency unavailable on an annual price before opening payment", async () => {
		const response = await guestCheckout(
			checkoutRequest("/api/settings/billing/guest-checkout", {
				priceId: "price_yearly",
				quantity: 1,
				continueCheckout: true,
				checkoutCurrency: "eur",
			}),
		);
		expect(response.status).toBe(400);
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it("rejects an unavailable account currency before changing the customer", async () => {
		mocks.currentUser.mockResolvedValue({
			id: "test-user",
			email: "",
			stripeCustomerId: null,
		});
		const response = await accountCheckout(
			checkoutRequest("/api/settings/billing/subscribe", {
				priceId: "price_yearly",
				quantity: 1,
				continueCheckout: true,
				checkoutCurrency: "eur",
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: true,
			message:
				"This currency is unavailable for the selected plan. Choose another currency and try again.",
		});
		expect(mocks.listCustomers).not.toHaveBeenCalled();
		expect(mocks.writeCustomerId).not.toHaveBeenCalled();
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it("renders an accessible compact picker with only available choices", () => {
		const markup = renderToStaticMarkup(
			createElement(CheckoutCurrencyPicker, {
				priceId: "price_yearly",
				quantity: 1,
				flow: "guest",
				period: "yearly",
				isOnBoarding: false,
				currencies: ["usd"],
			}),
		);
		expect(markup).toContain("Choose your billing currency");
		expect(markup).toContain("Automatic (based on location)");
		expect(markup).toContain("USD ($)");
		expect(markup).not.toContain("EUR (€)");
		expect(markup).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Currency<\/label>/);
		expect(markup).toContain("Continue to secure checkout");
	});

	it("preserves the plan, seats, onboarding, and chosen currency through sign-in", async () => {
		const loginUrl = new URL(
			checkoutSignInHref({
				priceId: "price_monthly",
				quantity: 3,
				isOnBoarding: true,
				choice: "usd",
			}),
			"https://cap.test",
		);
		const checkoutPath = loginUrl.searchParams.get("next");
		expect(loginUrl.pathname).toBe("/login");
		const resumedCheckout = new URL(checkoutPath ?? "", "https://cap.test");
		expect(resumedCheckout.pathname).toBe("/checkout");
		expect(resumedCheckout.searchParams.get("priceId")).toBe("price_monthly");
		expect(resumedCheckout.searchParams.get("quantity")).toBe("3");
		expect(resumedCheckout.searchParams.get("flow")).toBe("account");
		expect(resumedCheckout.searchParams.get("isOnBoarding")).toBe("true");
		expect(resumedCheckout.searchParams.get("checkoutCurrency")).toBe("usd");

		const page = await CheckoutPage({
			searchParams: Promise.resolve({
				priceId: "price_monthly",
				quantity: "3",
				flow: "account",
				isOnBoarding: "true",
				checkoutCurrency: "usd",
			}),
		});
		const markup = renderToStaticMarkup(page);
		expect(markup).toMatch(
			/<option value="usd" selected="">USD \(\$\)<\/option>/,
		);
	});

	it("keeps mobile guest checkout on its existing direct flow", async () => {
		const response = await guestCheckout(
			checkoutRequest("/api/settings/billing/guest-checkout", {
				priceId: "price_monthly",
				quantity: 1,
				platform: "mobile",
			}),
		);
		expect(response.status).toBe(200);
		expect(mocks.createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				success_url:
					"https://cap.test/mobile/checkout/complete?checkout=success",
			}),
		);
		expect(mocks.retrievePrice).not.toHaveBeenCalled();
	});
});

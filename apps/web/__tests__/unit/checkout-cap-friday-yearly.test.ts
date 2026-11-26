// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stripe = vi.hoisted(() => ({
	checkout: null as unknown,
}));
const actions = vi.hoisted(() => ({ changeProCheckoutPlan: vi.fn() }));

vi.mock("@stripe/react-stripe-js/checkout", () => ({
	useCheckoutElements: () => ({ type: "success", checkout: stripe.checkout }),
	BillingAddressElement: () => null,
	ExpressCheckoutElement: () => null,
	PaymentElement: () => null,
	TaxIdElement: () => null,
}));
vi.mock("next/navigation", () => ({
	usePathname: () => "/checkout",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/actions/billing/checkout", () => actions);
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/components/pages/HomeTwo/fonts", () => {
	const font = { className: "", variable: "" };
	return { htSans: font, htSerif: font, htGeist: font, htMono: font };
});

import { CheckoutForm } from "@/components/pages/checkout/CheckoutForm";
import { isYearlyOnlyPromotion, promotionForPlan } from "@/lib/checkout/plans";

const amount = (value: string, minor = 0) => ({
	amount: value,
	minorUnitsAmount: minor,
});

const checkoutFor = ({
	interval,
	promo,
}: {
	interval: "month" | "year";
	promo?: string;
}) => {
	const unit = interval === "year" ? 9800 : 1200;
	return {
		status: { type: "open" },
		livemode: false,
		email: null,
		currency: "usd",
		minorUnitsAmountDivisor: 100,
		lineItems: [
			{
				id: "li_pro",
				quantity: 1,
				recurring: { interval },
				unitAmount: amount(`$${unit / 100}.00`, unit),
				subtotal: amount(`$${unit / 100}.00`, unit),
			},
		],
		total: {
			subtotal: amount(`$${unit / 100}.00`, unit),
			total: amount("$0.00"),
		},
		recurring: null,
		discountAmounts: promo
			? [
					{
						displayName: promo,
						promotionCode: promo,
						amount: `$${unit / 200}.00`,
						minorUnitsAmount: unit / 2,
						recurring: { type: "forever" },
					},
				]
			: [],
		taxAmounts: [],
		updateLineItemQuantity: vi.fn(),
		applyPromotionCode: vi.fn(async () => ({ type: "success" })),
		removePromotionCode: vi.fn(async () => ({ type: "success" })),
		runServerUpdate: vi.fn(async (fn: () => Promise<void>) => {
			await fn();
			return { type: "success" };
		}),
	};
};

describe("Cap Friday is yearly only", () => {
	it("drops the code from monthly checkouts and keeps every other code", () => {
		expect(isYearlyOnlyPromotion(" blackfriday ")).toBe(true);
		expect(isYearlyOnlyPromotion("MIGRATE20")).toBe(false);
		expect(promotionForPlan("yearly", "BLACKFRIDAY")).toBe("BLACKFRIDAY");
		expect(promotionForPlan("monthly", "BLACKFRIDAY")).toBeNull();
		expect(promotionForPlan(null, "blackfriday")).toBeNull();
		expect(promotionForPlan("monthly", "MIGRATE20")).toBe("MIGRATE20");
		expect(promotionForPlan("monthly", undefined)).toBeNull();
	});

	describe("checkout form", () => {
		let root: Root;
		let container: HTMLDivElement;

		const render = () =>
			act(async () =>
				root.render(
					createElement(CheckoutForm, {
						clientSecret: Promise.resolve("cs_test_secret_x"),
						email: "buyer@example.com",
						onboarding: false,
						fallback: null,
					}),
				),
			);
		const button = (text: string) =>
			[...container.querySelectorAll("button")].find((node) =>
				node.textContent?.trim().startsWith(text),
			);

		beforeEach(() => {
			vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
			vi.stubGlobal("matchMedia", () => ({ matches: false }));
			vi.stubGlobal(
				"IntersectionObserver",
				class {
					observe() {}
					disconnect() {}
				},
			);
			actions.changeProCheckoutPlan.mockReset();
			actions.changeProCheckoutPlan.mockResolvedValue({ ok: true });
			container = document.createElement("div");
			document.body.append(container);
			root = createRoot(container);
		});

		afterEach(async () => {
			await act(async () => root.unmount());
			container.remove();
			vi.unstubAllGlobals();
		});

		it("keeps an annual Cap Friday checkout on annual", async () => {
			const checkout = checkoutFor({ interval: "year", promo: "BLACKFRIDAY" });
			stripe.checkout = checkout;
			await render();

			await act(async () => button("Monthly")?.click());

			expect(actions.changeProCheckoutPlan).not.toHaveBeenCalled();
			expect(checkout.runServerUpdate).not.toHaveBeenCalled();
			expect(container.textContent).toContain(
				"BLACKFRIDAY is for annual plans only. Remove it to pay monthly.",
			);
		});

		it("still switches plans with any other code", async () => {
			const checkout = checkoutFor({ interval: "year", promo: "MIGRATE20" });
			stripe.checkout = checkout;
			await render();

			await act(async () => button("Monthly")?.click());

			expect(actions.changeProCheckoutPlan).toHaveBeenCalledWith({
				clientSecret: "cs_test_secret_x",
				plan: "monthly",
			});
		});

		it("refuses the code on a monthly checkout", async () => {
			const checkout = checkoutFor({ interval: "month" });
			stripe.checkout = checkout;
			await render();

			await act(async () => button("Add a promotion code")?.click());
			const input = container.querySelector<HTMLInputElement>(
				"input[placeholder='Promotion code']",
			);
			await act(async () => {
				if (!input) return;
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set?.call(input, "blackfriday");
				input.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await act(async () => button("Apply")?.click());

			expect(checkout.applyPromotionCode).not.toHaveBeenCalled();
			expect(container.textContent).toContain(
				"BLACKFRIDAY is for annual plans only. Switch to Annual to use it.",
			);
		});
	});
});

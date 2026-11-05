import type { StripeCheckoutStatus } from "@stripe/stripe-js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const stripe = vi.hoisted(() => ({
	status: { type: "expired" } as StripeCheckoutStatus,
}));

vi.mock("@stripe/react-stripe-js/checkout", () => ({
	useCheckoutElements: () => ({
		type: "success",
		checkout: { id: "cs_test_completed", status: stripe.status },
	}),
	BillingAddressElement: () => null,
	ExpressCheckoutElement: () => null,
	PaymentElement: () => null,
	TaxIdElement: () => null,
}));
vi.mock("@/actions/billing/checkout", () => ({
	changeProCheckoutPlan: vi.fn(),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/components/pages/HomeTwo/fonts", () => {
	const font = { className: "", variable: "" };
	return { htSans: font, htSerif: font, htGeist: font, htMono: font };
});

import { CheckoutForm } from "@/components/pages/checkout/CheckoutForm";

const render = (email: string | null) =>
	renderToStaticMarkup(
		createElement(CheckoutForm, {
			clientSecret: Promise.resolve("cs_test_completed_secret_x"),
			email,
			onboarding: false,
			fallback: null,
		}),
	);

describe("completed in-app checkout", () => {
	it.each([null, "buyer@example.com"])(
		"does not claim an unpaid checkout is paid for %s",
		(email) => {
			stripe.status = { type: "complete", paymentStatus: "unpaid" };
			const html = render(email);

			expect(html).not.toContain("already paid");
			expect(html).not.toContain("Your Cap Pro subscription is set up");
			expect(html).toContain(
				'href="/checkout/complete?session_id=cs_test_completed"',
			);
			expect(html).not.toContain('href="/dashboard/caps"');
		},
	);

	it.each(["paid", "no_payment_required"] as const)(
		"sends %s checkouts through the account-aware completion page",
		(paymentStatus) => {
			stripe.status = { type: "complete", paymentStatus };

			expect(render(null)).toContain(
				'href="/checkout/complete?session_id=cs_test_completed"',
			);
		},
	);

	it("still offers a new checkout when the session has expired", () => {
		stripe.status = { type: "expired" };
		const html = render(null);

		expect(html).toContain("This checkout has expired");
		expect(html).toContain("Start a new checkout");
		expect(html).not.toContain("/checkout/complete");
	});
});

// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UpdateResult = { type: "success" } | { type: "error"; error: unknown };

const stripe = vi.hoisted(() => ({
	checkout: null as unknown,
}));

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
vi.mock("@/actions/billing/checkout", () => ({
	changeProCheckoutPlan: vi.fn(),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/components/pages/HomeTwo/fonts", () => {
	const font = { className: "", variable: "" };
	return { htSans: font, htSerif: font, htGeist: font, htMono: font };
});

import { CheckoutForm } from "@/components/pages/checkout/CheckoutForm";

const amount = (value: string) => ({ amount: value, minorUnitsAmount: 0 });

const checkoutWithSeats = (
	quantity: number,
	updateLineItemQuantity: (args: {
		lineItem: string;
		quantity: number;
	}) => Promise<UpdateResult>,
) => ({
	status: { type: "open" },
	livemode: false,
	email: null,
	currency: "usd",
	minorUnitsAmountDivisor: 100,
	lineItems: [
		{
			id: "li_seats",
			quantity,
			recurring: { interval: "month" },
			unitAmount: { amount: "$12.00", minorUnitsAmount: 1200 },
			subtotal: amount(`$${12 * quantity}.00`),
		},
	],
	total: { subtotal: amount("$0.00"), total: amount("$0.00") },
	recurring: null,
	discountAmounts: [],
	taxAmounts: [],
	updateLineItemQuantity,
});

describe("checkout seat control", () => {
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
	const seatsInput = () =>
		container.querySelector<HTMLInputElement>("input[inputmode=numeric]");
	const payButton = () =>
		container.querySelector<HTMLButtonElement>("button[type=submit]");
	const typeSeats = (value: string) =>
		act(async () => {
			const input = seatsInput();
			if (!input) return;
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	const addUser = () =>
		act(async () =>
			container
				.querySelector<HTMLButtonElement>("button[aria-label='Add a user']")
				?.click(),
		);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("matchMedia", () => ({ matches: false }));
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("keeps a seat count chosen while the previous update is in flight", async () => {
		const pending: Array<() => void> = [];
		const update = vi.fn(
			() =>
				new Promise<UpdateResult>((resolve) => {
					pending.push(() => resolve({ type: "success" }));
				}),
		);
		stripe.checkout = checkoutWithSeats(1, update);
		await render();

		await addUser();
		await act(async () => vi.advanceTimersByTime(400));
		expect(update).toHaveBeenLastCalledWith({
			lineItem: "li_seats",
			quantity: 2,
		});

		await addUser();
		expect(seatsInput()?.value).toBe("3");

		stripe.checkout = checkoutWithSeats(2, update);
		await render();
		await act(async () => pending[0]?.());

		expect(seatsInput()?.value).toBe("3");
		await act(async () => vi.advanceTimersByTime(400));
		expect(update).toHaveBeenLastCalledWith({
			lineItem: "li_seats",
			quantity: 3,
		});
		expect(payButton()?.disabled).toBe(true);

		await act(async () => pending[1]?.());
		stripe.checkout = checkoutWithSeats(3, update);
		await render();
		expect(seatsInput()?.value).toBe("3");
		expect(payButton()?.disabled).toBe(false);
	});

	it("restores the session's count when an update fails", async () => {
		const update = vi.fn(
			async (): Promise<UpdateResult> => ({
				type: "error",
				error: { message: "nope" },
			}),
		);
		stripe.checkout = checkoutWithSeats(1, update);
		await render();

		await addUser();
		await act(async () => vi.advanceTimersByTime(400));

		expect(update).toHaveBeenCalledOnce();
		expect(seatsInput()?.value).toBe("1");
		expect(container.textContent).toContain(
			"Couldn't update the number of users.",
		);
	});

	it("keeps a newer choice when an older update fails", async () => {
		const pending: Array<() => void> = [];
		const update = vi.fn(
			() =>
				new Promise<UpdateResult>((resolve) => {
					pending.push(() =>
						resolve({ type: "error", error: { message: "nope" } }),
					);
				}),
		);
		stripe.checkout = checkoutWithSeats(1, update);
		await render();

		await addUser();
		await act(async () => vi.advanceTimersByTime(400));
		await addUser();
		await act(async () => pending[0]?.());

		expect(seatsInput()?.value).toBe("3");
		expect(payButton()?.disabled).toBe(true);

		update.mockImplementationOnce(async () => ({ type: "success" }));
		await act(async () => vi.advanceTimersByTime(400));
		expect(update).toHaveBeenLastCalledWith({
			lineItem: "li_seats",
			quantity: 3,
		});
		stripe.checkout = checkoutWithSeats(3, update);
		await render();
		expect(payButton()?.disabled).toBe(false);
	});

	it("restores the session's count when a typed count with a leading zero fails", async () => {
		const update = vi.fn(
			async (): Promise<UpdateResult> => ({
				type: "error",
				error: { message: "nope" },
			}),
		);
		stripe.checkout = checkoutWithSeats(1, update);
		await render();

		await typeSeats("02");
		await act(async () => vi.advanceTimersByTime(400));

		expect(update).toHaveBeenLastCalledWith({
			lineItem: "li_seats",
			quantity: 2,
		});
		expect(seatsInput()?.value).toBe("1");
		expect(payButton()?.disabled).toBe(false);
	});
});

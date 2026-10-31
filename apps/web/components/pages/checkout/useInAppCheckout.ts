"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useStripeContext } from "@/app/Layout/StripeContext";
import { type CheckoutPlan, checkoutPath } from "@/lib/checkout/plans";

// Opens /checkout with a client-side navigation instead of the billing API
// round trips and a full page load, and starts Stripe.js on hover or touch so
// the payment form is ready sooner. Null when the in-app checkout is off.
export function useInAppCheckout() {
	const { checkoutKey } = useStripeContext();
	const router = useRouter();
	const [pending, startTransition] = useTransition();

	if (!checkoutKey) return null;

	return {
		pending,
		warm: () => {
			void import("./stripe-client").then(({ getStripe }) =>
				getStripe(checkoutKey),
			);
		},
		open: (input: { plan: CheckoutPlan; seats: number }) =>
			startTransition(() => router.push(checkoutPath(input))),
	};
}

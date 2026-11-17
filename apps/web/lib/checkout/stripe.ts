import { serverEnv } from "@cap/env";
import Stripe from "stripe-v23";

// Checkout Sessions in `elements` mode only exist on recent API versions, while
// the rest of the app (webhooks, billing, BAA, SSO) is typed and tested against
// the 2023-10-16 objects from @cap/utils. This client is scoped to the in-app
// checkout so that move can happen separately.
let client: Stripe | undefined;

export const checkoutStripe = () => {
	client ??= new Stripe(serverEnv().STRIPE_SECRET_KEY ?? "", {
		appInfo: { name: "Cap", version: "0.1.0" },
	});
	return client;
};

export type CheckoutSession = Stripe.Checkout.Session;

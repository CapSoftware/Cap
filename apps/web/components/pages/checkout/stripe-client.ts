import { loadStripe, type Stripe } from "@stripe/stripe-js";

let loader: { key: string; promise: Promise<Stripe | null> } | undefined;

// One Stripe.js instance per key, shared by the pricing CTAs that warm it up
// and the checkout that mounts on it after a client-side navigation.
export const getStripe = (key: string) => {
	if (loader?.key !== key) {
		loader = { key, promise: loadStripe(key) };
	}
	return loader.promise;
};

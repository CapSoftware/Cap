import { buildEnv, serverEnv } from "@cap/env";

export const customCheckoutEnabled = () =>
	Boolean(serverEnv().STRIPE_SECRET_KEY && serverEnv().STRIPE_PUBLISHABLE_KEY);

// The publishable key handed to pricing CTAs so they can open /checkout
// directly; null sends them through the billing API routes instead.
export const inAppCheckoutKey = (): string | null =>
	buildEnv.NEXT_PUBLIC_IS_CAP === "true" && customCheckoutEnabled()
		? (serverEnv().STRIPE_PUBLISHABLE_KEY ?? null)
		: null;

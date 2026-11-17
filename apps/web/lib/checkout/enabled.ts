import { buildEnv, serverEnv } from "@cap/env";

// The /checkout page only exists on Cap Cloud, so every route that sends
// buyers there must apply the same gate as the page itself.
export const customCheckoutEnabled = () =>
	buildEnv.NEXT_PUBLIC_IS_CAP === "true" &&
	Boolean(serverEnv().STRIPE_SECRET_KEY && serverEnv().STRIPE_PUBLISHABLE_KEY);

// The publishable key handed to pricing CTAs so they can open /checkout
// directly; null sends them through the billing API routes instead.
export const inAppCheckoutKey = (): string | null =>
	customCheckoutEnabled() ? (serverEnv().STRIPE_PUBLISHABLE_KEY ?? null) : null;

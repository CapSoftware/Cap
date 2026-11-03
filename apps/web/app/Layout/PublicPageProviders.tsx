import { STRIPE_PLAN_IDS } from "@cap/utils";
import type { PropsWithChildren } from "react";
import { inAppCheckoutKey } from "@/lib/checkout/enabled";
import { DeferredSonnerToaster } from "./DeferredSonnerToaster";
import { QueryProvider } from "./QueryProvider";
import { StripeContextProvider } from "./StripeContext";

export function PublicPageProviders({ children }: PropsWithChildren) {
	const plans =
		process.env.VERCEL_ENV === "production"
			? STRIPE_PLAN_IDS.production
			: STRIPE_PLAN_IDS.development;

	return (
		<StripeContextProvider plans={plans} checkoutKey={inAppCheckoutKey()}>
			<QueryProvider>
				<DeferredSonnerToaster />
				{children}
			</QueryProvider>
		</StripeContextProvider>
	);
}

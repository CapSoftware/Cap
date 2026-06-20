"use client";

import { DeferredSonnerToaster } from "@/app/Layout/DeferredSonnerToaster";
import { QueryProvider } from "@/app/Layout/QueryProvider";
import { StripeContextProvider } from "@/app/Layout/StripeContext";
import Pricing from "./Pricing";

export type StripePlans = { yearly: string; monthly: string };

export function HomepagePricingIsland({ plans }: { plans: StripePlans }) {
	return (
		<StripeContextProvider plans={plans}>
			<QueryProvider>
				<DeferredSonnerToaster />
				<Pricing />
			</QueryProvider>
		</StripeContextProvider>
	);
}

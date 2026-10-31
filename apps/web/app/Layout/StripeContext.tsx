"use client";

import { createContext, type PropsWithChildren, use } from "react";

type StripeContext = {
	plans: { yearly: string; monthly: string };
	// Publishable key when the in-app Cap Pro checkout is on, otherwise null.
	checkoutKey: string | null;
};
const StripeContext = createContext<StripeContext | undefined>(undefined);

export function StripeContextProvider({
	children,
	plans,
	checkoutKey = null,
}: PropsWithChildren & Partial<StripeContext>) {
	return (
		<StripeContext.Provider value={plans ? { plans, checkoutKey } : undefined}>
			{children}
		</StripeContext.Provider>
	);
}

export function useStripeContext() {
	const context = use(StripeContext);
	if (!context) {
		throw new Error(
			"useStripeContext must be used within a StripeContextProvider",
		);
	}
	return context;
}

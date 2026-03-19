"use client";

import { createContext, type PropsWithChildren, use } from "react";

type StripeContext = { plans: { yearly: string; monthly: string } };
const StripeContext = createContext<StripeContext | undefined>(undefined);

export function StripeContextProvider({
	children,
	plans,
}: PropsWithChildren & Partial<StripeContext>) {
	return (
		<StripeContext.Provider value={plans ? { plans } : undefined}>
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

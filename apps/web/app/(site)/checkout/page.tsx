import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { preconnect } from "react-dom";
import {
	type CreateCheckoutResult,
	createProCheckout,
} from "@/actions/billing/checkout";
import { getCurrentPlan } from "@/actions/billing/current-plan";
import { CheckoutView } from "@/components/pages/checkout/CheckoutView";
import { ManagePlan } from "@/components/pages/checkout/ManagePlan";
import { customCheckoutEnabled } from "@/lib/checkout/enabled";
import {
	type CheckoutEnvironment,
	isCheckoutPlan,
	parseCheckoutSeats,
	planPriceId,
} from "@/lib/checkout/plans";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Checkout | Cap",
	robots: { index: false, follow: false },
};

const first = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

export default async function CheckoutPage(props: {
	searchParams: Promise<{
		plan?: string | string[];
		seats?: string | string[];
		onboarding?: string | string[];
	}>;
}) {
	const [searchParams, user] = await Promise.all([
		props.searchParams,
		getCurrentUser(),
	]);
	const publishableKey = serverEnv().STRIPE_PUBLISHABLE_KEY;

	if (!publishableKey || !customCheckoutEnabled()) redirect("/pricing");
	const seats = parseCheckoutSeats(first(searchParams.seats));

	if (user && userIsPro(user)) {
		return <ManagePlan plan={await getCurrentPlan()} requestedSeats={seats} />;
	}

	const requestedPlan = first(searchParams.plan);
	const plan = isCheckoutPlan(requestedPlan) ? requestedPlan : "monthly";
	const onboarding = first(searchParams.onboarding) === "1" && Boolean(user);
	const environment: CheckoutEnvironment =
		serverEnv().VERCEL_ENV === "production" ? "production" : "development";

	// Not awaited: the page streams straight away and the session arrives in
	// the same response, instead of a second request after hydration.
	const session = createProCheckout({ plan, seats, onboarding }).catch(
		(): CreateCheckoutResult => ({ ok: false, reason: "unavailable" }),
	);
	preconnect("https://js.stripe.com");

	return (
		<CheckoutView
			session={session}
			publishableKey={publishableKey}
			email={user?.email ?? null}
			plan={plan}
			seats={seats}
			onboarding={onboarding}
			priceIds={{
				monthly: planPriceId("monthly", environment),
				yearly: planPriceId("yearly", environment),
			}}
		/>
	);
}

"use client";

import { classNames } from "@cap/utils/helpers";
import NumberFlow from "@number-flow/react";
import { useMutation } from "@tanstack/react-query";
import { useCurrency } from "hooks/useCurrency";
import { useState } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { useStripeContext } from "@/app/Layout/StripeContext";
import { trackEvent } from "@/app/utils/analytics";
import { BTN_PRIMARY, MODE_THEME } from "@/components/pages/HomeTwo/theme";
import { homepageCopy } from "@/data/homepage-copy";
import { PRICING } from "@/data/pricing";
import { Segmented, Stepper } from "./controls";
import { PlanCard, type PlanToggle } from "./PlanCard";

const copy = homepageCopy.pricing.pro;
const theme = MODE_THEME.instant;

export const ProCard = ({ collapsed, onToggle }: PlanToggle) => {
	const stripeCtx = useStripeContext();
	const user = useCurrentUser();
	const { symbol } = useCurrency();
	const [users, setUsers] = useState(1);
	const [annual, setAnnual] = useState(false);

	const perUser = annual ? copy.pricing.annual : copy.pricing.monthly;
	const total = annual
		? PRICING.pro.yearlyTotal * users
		: copy.pricing.monthly * users;

	const guestCheckout = useMutation({
		mutationFn: async (priceId: string) => {
			const response = await fetch("/api/settings/billing/guest-checkout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ priceId, quantity: users }),
			});
			const data = await response.json();
			if (data.url) {
				window.location.href = data.url;
			} else {
				toast.error("Failed to create checkout session");
			}
		},
		onError: () => {
			toast.error("An error occurred. Please try again.");
		},
	});

	const planCheckout = useMutation({
		mutationFn: async () => {
			const priceId = stripeCtx.plans[annual ? "yearly" : "monthly"];
			trackEvent("pricing_cta_clicked", {
				source_page: "pricing_cards",
				plan_name: "pro",
				authenticated: Boolean(user?.email),
				is_pro: Boolean(user?.isPro),
				cta_action: user?.email ? "checkout" : "guest_checkout",
				target_billing_period: annual ? "annual" : "monthly",
				quantity: users,
			});

			const response = await fetch("/api/settings/billing/subscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ priceId, quantity: users }),
			});
			const data = await response.json();

			if (data.auth === false) {
				await guestCheckout.mutateAsync(priceId);
				return;
			}
			if (data.subscription === true) {
				toast.success("You are already on the Cap Pro plan");
			}
			if (data.url) {
				window.location.href = data.url;
			}
		},
		onError: () => {
			toast.error("Failed to start subscription process");
		},
	});

	const loading = planCheckout.isPending || guestCheckout.isPending;

	return (
		<PlanCard
			name={copy.title}
			tag="Most popular"
			theme={theme}
			summary={`${symbol}${copy.pricing.monthly} per user, per month`}
			collapsed={collapsed}
			onToggle={onToggle}
			featured
			blurb="Everything in Desktop, plus unlimited cloud sharing, AI, and team collaboration."
			price={
				<>
					{symbol}
					<NumberFlow value={perUser} />
				</>
			}
			cadence="per user, per month"
			note={
				annual
					? "Billed annually. Save 32% against monthly."
					: `Or ${symbol}${copy.pricing.annual} a month, billed annually.`
			}
			controls={
				<>
					<Segmented
						ariaLabel="Billing cycle for Cap Pro"
						value={annual ? "annual" : "monthly"}
						onChange={(value) => setAnnual(value === "annual")}
						options={[
							{ value: "monthly", label: "Monthly" },
							{ value: "annual", label: "Annual", badge: "Save 32%" },
						]}
						theme={theme}
					/>
					<Stepper
						label="Users"
						value={users}
						onIncrement={() => setUsers((prev) => prev + 1)}
						onDecrement={() => setUsers((prev) => Math.max(1, prev - 1))}
						decrementLabel="Decrease user count"
						incrementLabel="Increase user count"
					/>
					<p className="flex items-baseline justify-between text-[14px] text-[rgba(17,17,17,0.6)]">
						<span>Total</span>
						<span>
							<span className="font-medium tabular-nums text-[#111111]">
								{symbol}
								<NumberFlow value={total} />
							</span>{" "}
							{annual ? "per year" : "per month"}
						</span>
					</p>
				</>
			}
			cta={
				<button
					type="button"
					onClick={() => planCheckout.mutate()}
					disabled={loading}
					className={classNames(
						BTN_PRIMARY,
						"w-full disabled:cursor-not-allowed disabled:opacity-60",
					)}
				>
					{loading ? "Opening checkout..." : "Get Cap Pro"}
				</button>
			}
			ctaNote="Cancel anytime. Your recordings stay yours."
			featuresTitle="Everything in Desktop License, plus:"
			features={copy.features.slice(1)}
		/>
	);
};

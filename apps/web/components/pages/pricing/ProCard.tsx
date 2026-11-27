"use client";

import { classNames } from "@cap/utils/helpers";
import NumberFlow from "@number-flow/react";
import { useMutation } from "@tanstack/react-query";
import { useCurrency } from "hooks/useCurrency";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { useStripeContext } from "@/app/Layout/StripeContext";
import { trackEvent } from "@/app/utils/analytics";
import { useEnded } from "@/components/pages/blackfriday/Claim";
import { CODE, PRICE } from "@/components/pages/blackfriday/content";
import {
	OFFER_LINK_EVENT,
	PRICING_OFFER_ANCHOR,
} from "@/components/pages/blackfriday/SiteBanner";
import { useInAppCheckout } from "@/components/pages/checkout/useInAppCheckout";
import {
	BTN_PRIMARY,
	MODE_THEME,
	type ModeTheme,
} from "@/components/pages/HomeTwo/theme";
import { homepageCopy } from "@/data/homepage-copy";
import { PRICING } from "@/data/pricing";
import { CHECKOUT_RATE_LIMITED_MESSAGE } from "@/lib/checkout/messages";
import { isYearlyOnlyPromotion } from "@/lib/checkout/plans";
import { Segmented, Stepper } from "./controls";
import { PlanCard, type PlanToggle } from "./PlanCard";

const copy = homepageCopy.pricing.pro;

const CAP_FRIDAY_THEME: ModeTheme = {
	...MODE_THEME.instant,
	image: [
		"radial-gradient(92% 95% at 6% 6%, #FFD68C 0%, rgba(255,214,140,0) 66%)",
		"radial-gradient(70% 78% at 96% 2%, #FF8078 0%, rgba(255,128,120,0) 60%)",
		"radial-gradient(82% 76% at 92% 96%, #B0369F 0%, rgba(176,54,159,0) 62%)",
		"radial-gradient(92% 88% at 24% 100%, #FF4D8D 0%, rgba(255,77,141,0) 70%)",
	].join(","),
	base: "#FF6F8E",
	chip: "#FFE8EF",
	glyph: "#C22A63",
};

const CAP_FRIDAY_FRAME_SHADOW =
	"shadow-[0_28px_56px_-36px_rgba(255,77,141,0.6)]";

const CAP_FRIDAY_CTA =
	"inline-flex h-[48px] w-full items-center justify-center rounded-[12px] bg-[#141012] px-6 text-[16px] font-medium text-[#F5F1EA] shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_1px_2px_rgba(20,16,18,0.4),0_14px_28px_-12px_rgba(255,77,141,0.65)] transition-[background-color,transform,box-shadow] duration-200 hover:bg-[#261C22] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_2px_4px_rgba(20,16,18,0.4),0_18px_34px_-12px_rgba(255,77,141,0.8)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#141012] focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60";

const PromoParam = ({
	onChange,
}: {
	onChange: (promo: string | null) => void;
}) => {
	const promo = useSearchParams().get("promo");
	useLayoutEffect(() => onChange(promo), [promo, onChange]);
	return null;
};

export const ProCard = ({ collapsed, onToggle }: PlanToggle) => {
	const stripeCtx = useStripeContext();
	const user = useCurrentUser();
	const { symbol } = useCurrency();
	const [users, setUsers] = useState(1);
	const [annual, setAnnual] = useState(false);
	const [promo, setPromo] = useState<string | null>(null);
	const offerEnded = useEnded();
	const inAppCheckout = useInAppCheckout();

	const capFriday = isYearlyOnlyPromotion(promo) && !offerEnded;
	const discounted = capFriday && annual;
	const theme = capFriday ? CAP_FRIDAY_THEME : MODE_THEME.instant;

	const card = useRef({ collapsed, onToggle });
	useLayoutEffect(() => {
		card.current = { collapsed, onToggle };
	});
	const scrollWhenOpen = useRef(false);

	useEffect(() => {
		if (!capFriday) return;
		const showOffer = () => {
			setAnnual(true);
			if (!card.current.collapsed) return;
			scrollWhenOpen.current = true;
			card.current.onToggle();
		};
		showOffer();
		window.addEventListener(OFFER_LINK_EVENT, showOffer);
		return () => window.removeEventListener(OFFER_LINK_EVENT, showOffer);
	}, [capFriday]);

	useEffect(() => {
		if (collapsed || !scrollWhenOpen.current) return;
		scrollWhenOpen.current = false;
		document.getElementById(PRICING_OFFER_ANCHOR)?.scrollIntoView();
	}, [collapsed]);

	const perUser = discounted
		? PRICE.perMonth
		: annual
			? copy.pricing.annual
			: copy.pricing.monthly;
	const total = discounted
		? PRICE.now * users
		: annual
			? PRICING.pro.yearlyTotal * users
			: copy.pricing.monthly * users;
	const checkoutPromo = discounted ? { promo: CODE } : {};

	const guestCheckout = useMutation({
		mutationFn: async (priceId: string) => {
			const response = await fetch("/api/settings/billing/guest-checkout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ priceId, quantity: users, ...checkoutPromo }),
			});
			const data = await response.json();
			if (response.status === 429) {
				toast.error(CHECKOUT_RATE_LIMITED_MESSAGE);
				return;
			}
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

			if (inAppCheckout) {
				inAppCheckout.open({
					plan: annual ? "yearly" : "monthly",
					seats: users,
					...checkoutPromo,
				});
				return;
			}

			const response = await fetch("/api/settings/billing/subscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ priceId, quantity: users, ...checkoutPromo }),
			});
			const data = await response.json();

			if (data.auth === false) {
				await guestCheckout.mutateAsync(priceId);
				return;
			}
			if (data.subscription === true) {
				toast.success("You are already on the Cap Pro plan");
			}
			if (response.status === 429) {
				toast.error(CHECKOUT_RATE_LIMITED_MESSAGE);
				return;
			}
			if (data.url) {
				window.location.href = data.url;
			}
		},
		onError: () => {
			toast.error("Failed to start subscription process");
		},
	});

	const loading =
		planCheckout.isPending ||
		guestCheckout.isPending ||
		Boolean(inAppCheckout?.pending);

	return (
		<>
			<Suspense fallback={null}>
				<PromoParam onChange={setPromo} />
			</Suspense>
			<PlanCard
				id={PRICING_OFFER_ANCHOR}
				name={copy.title}
				tag={capFriday ? "Cap Friday, 50% off" : "Most popular"}
				theme={theme}
				frameShadow={capFriday ? CAP_FRIDAY_FRAME_SHADOW : undefined}
				summary={`${symbol}${discounted ? PRICE.perMonth : copy.pricing.monthly} per user, per month`}
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
				cadence={
					<span className="relative">
						per user, per month
						{discounted ? (
							<>
								<span className="sr-only">, was </span>
								<s className="absolute bottom-full left-0 mb-px text-[17px] leading-none tracking-[-0.02em] tabular-nums text-[rgba(17,17,17,0.4)]">
									{symbol}
									{copy.pricing.annual}
								</s>
							</>
						) : null}
					</span>
				}
				note={
					discounted
						? `Billed annually. ${CODE} applied.`
						: capFriday
							? "Cap Friday is 50% off annual billing."
							: annual
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
								{
									value: "annual",
									label: "Annual",
									badge: capFriday ? "50% off" : "Save 32%",
								},
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
								{discounted ? (
									<>
										<s className="mr-1.5 tabular-nums text-[rgba(17,17,17,0.38)]">
											{symbol}
											{PRICING.pro.yearlyTotal * users}
										</s>
										<span className="sr-only">now </span>
									</>
								) : null}
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
						onPointerEnter={inAppCheckout?.warm}
						onTouchStart={inAppCheckout?.warm}
						onFocus={inAppCheckout?.warm}
						disabled={loading}
						className={
							discounted
								? CAP_FRIDAY_CTA
								: classNames(
										BTN_PRIMARY,
										"w-full disabled:cursor-not-allowed disabled:opacity-60",
									)
						}
					>
						{loading
							? "Opening checkout..."
							: discounted
								? "Claim 50% off"
								: "Get Cap Pro"}
					</button>
				}
				ctaNote="Cancel anytime. Your recordings stay yours."
				featuresTitle="Everything in Desktop License, plus:"
				features={copy.features.slice(1)}
			/>
		</>
	);
};

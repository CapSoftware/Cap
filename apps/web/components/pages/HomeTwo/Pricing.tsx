"use client";

import { classNames } from "@cap/utils/helpers";
import { Check } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { homepageCopy } from "@/data/homepage-copy";
import {
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	H_SECTION,
	MODE_THEME,
	type ModeTheme,
} from "./theme";

const { commercial, pro, subtitle, lovedBy } = homepageCopy.pricing;

const BLURB = {
	commercial:
		"A commercial licence for the Cap desktop app, with unlimited local recording and editing.",
	pro: "Everything in Desktop plus unlimited cloud features for sharing and collaboration.",
};

type Billing = "annual" | "monthly";

const money = (amount: number) =>
	Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;

const PlanCard = ({
	name,
	badge,
	blurb,
	price,
	cadence,
	note,
	features,
	cta,
	href,
	onClick,
	primary,
	theme,
}: {
	name: string;
	badge?: string;
	blurb: string;
	price: string;
	cadence: string;
	note: string;
	features: readonly string[];
	cta: string;
	href: string;
	onClick?: () => void;
	primary?: boolean;
	theme: ModeTheme;
}) => (
	<div className="flex flex-col rounded-[20px] bg-white p-7 shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_1px_2px_rgba(17,17,17,0.03)] lg:p-8">
		<div className="flex items-center gap-2.5">
			<span className="text-[15px] font-medium text-[#111111]">{name}</span>
			{badge ? (
				<span
					className="rounded-full px-2.5 py-1 text-[12px] leading-none"
					style={{ background: theme.chip, color: theme.glyph }}
				>
					{badge}
				</span>
			) : null}
		</div>

		<p
			className={`${BODY_TEXT} mt-3 min-h-[48px] max-w-[380px] text-[15px] leading-[1.5] text-[rgba(17,17,17,0.72)]`}
		>
			{blurb}
		</p>

		<div className="mt-7 flex items-baseline gap-2">
			<span className="text-[46px] font-normal leading-none tracking-[-0.03em] text-[#111111]">
				{price}
			</span>
			<span className="text-[14px] text-[rgba(17,17,17,0.64)]">{cadence}</span>
		</div>
		<p className="mt-2 text-[13.5px] text-[rgba(17,17,17,0.64)]">{note}</p>

		<Link
			href={href}
			onClick={onClick}
			className={classNames(primary ? BTN_PRIMARY : BTN_SECONDARY, "mt-7")}
		>
			{cta}
		</Link>

		<ul className="mt-8 space-y-3 border-t border-[#E1E7EE] pt-7">
			{features.map((feature) => (
				<li key={feature} className="flex items-start gap-3">
					<span
						className="mt-px grid size-5 shrink-0 place-items-center rounded-full"
						style={{ background: theme.chip, color: theme.glyph }}
					>
						<Check className="size-3" strokeWidth={2.5} />
					</span>
					<span className="text-[14px] leading-snug text-[rgba(17,17,17,0.72)]">
						{feature}
					</span>
				</li>
			))}
		</ul>
	</div>
);

export const Pricing = () => {
	const [billing, setBilling] = useState<Billing>("monthly");
	const annual = billing === "annual";

	return (
		<section className="px-5 py-20 lg:py-28">
			<div className="mx-auto max-w-[1060px]">
				<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
					<h2
						className={`${H_SECTION} text-balance text-[clamp(34px,4.6vw,54px)] leading-[1.02]`}
					>
						Simple, honest pricing
					</h2>
					<p
						className={`${BODY_TEXT} mt-5 max-w-[560px] text-balance text-[17px] leading-[1.5] text-[rgba(17,17,17,0.64)] sm:text-[18px]`}
					>
						{subtitle}
					</p>

					<div className="mt-8 flex items-center gap-0.5 rounded-full bg-[#EEF1F5] p-1 shadow-[inset_0_0_0_1px_rgba(17,17,17,0.04)]">
						{(["annual", "monthly"] as const).map((option) => {
							const active = billing === option;
							return (
								<button
									key={option}
									type="button"
									onClick={() => setBilling(option)}
									aria-pressed={active}
									className={classNames(
										"h-8 rounded-full px-4 text-[13px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-1 focus-visible:ring-offset-white",
										active
											? "bg-white text-[#111111] shadow-[0_1px_2px_rgba(17,17,17,0.08),0_0_0_1px_rgba(17,17,17,0.06)]"
											: "text-[rgba(17,17,17,0.64)] hover:text-[#111111]",
									)}
								>
									{option === "annual" ? "Annual" : "Monthly"}
								</button>
							);
						})}
					</div>
					<p className="mt-4 text-[13.5px] text-[rgba(17,17,17,0.64)]">
						{lovedBy}
					</p>
				</div>

				<div className="mt-14 grid gap-3 lg:grid-cols-2">
					<PlanCard
						name={commercial.title}
						blurb={BLURB.commercial}
						price={money(
							annual ? commercial.pricing.yearly : commercial.pricing.lifetime,
						)}
						cadence={annual ? "per year" : "one time"}
						note={
							annual
								? `Or ${money(commercial.pricing.lifetime)} once, for a licence that never renews.`
								: `Or ${money(commercial.pricing.yearly)} a year if you would rather pay as you go.`
						}
						features={commercial.features}
						cta={commercial.cta}
						href="/pricing"
						theme={MODE_THEME.screenshot}
					/>
					<PlanCard
						name={pro.title}
						badge={pro.badge}
						blurb={BLURB.pro}
						price={money(annual ? pro.pricing.annual : pro.pricing.monthly)}
						cadence="per user, per month"
						note={
							annual
								? "Billed annually. Save 32% against monthly."
								: `Billed monthly. Switch to annual for ${money(pro.pricing.annual)} a month.`
						}
						features={pro.features}
						cta={pro.cta}
						href="/pricing"
						onClick={() =>
							trackEvent("pricing_cta_clicked", {
								source_page: "home_pricing",
								cta_location: "primary",
								target_url: "/pricing",
							})
						}
						primary
						theme={MODE_THEME.instant}
					/>
				</div>
			</div>
		</section>
	);
};

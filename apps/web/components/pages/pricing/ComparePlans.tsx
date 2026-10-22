"use client";

import { classNames } from "@cap/utils/helpers";
import { useCurrency } from "hooks/useCurrency";
import { Check } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { useStripeContext } from "@/app/Layout/StripeContext";
import { trackEvent } from "@/app/utils/analytics";
import {
	BODY_TEXT,
	H_SECTION,
	MODE_THEME,
	MONO,
} from "@/components/pages/HomeTwo/theme";
import { PRICING } from "@/data/pricing";

type PlanKey = "free" | "desktop" | "pro";

type Plan = {
	key: PlanKey;
	name: string;
	short: string;
	price: string;
	compactPrice: string;
};

type FeatureValue = boolean | string;

type FeatureRow = {
	label: string;
	free: FeatureValue;
	desktop: FeatureValue;
	pro: FeatureValue;
};

type FeatureSection = {
	title: string;
	rows: FeatureRow[];
};

const sections: FeatureSection[] = [
	{
		title: "Recording & editing",
		rows: [
			{
				label: "Studio Mode with full editor",
				free: true,
				desktop: true,
				pro: true,
			},
			{
				label: "Unlimited local recordings & editing",
				free: false,
				desktop: true,
				pro: true,
			},
			{ label: "4K / 60fps export", free: true, desktop: true, pro: true },
			{ label: "Export to any format", free: true, desktop: true, pro: true },
			{ label: "Commercial usage", free: false, desktop: true, pro: true },
		],
	},
	{
		title: "Cloud & sharing",
		rows: [
			{
				label: "Shareable links",
				free: "Up to 5 min",
				desktop: "Up to 5 min",
				pro: "Unlimited",
			},
			{
				label: "Unlimited cloud storage & bandwidth",
				free: false,
				desktop: false,
				pro: true,
			},
			{
				label: "Custom domain (cap.yourdomain.com)",
				free: false,
				desktop: false,
				pro: true,
			},
			{
				label: "Password protected shares",
				free: false,
				desktop: false,
				pro: true,
			},
			{
				label: "Custom S3 bucket & Google Drive support",
				free: false,
				desktop: false,
				pro: true,
			},
			{ label: "Loom video importer", free: false, desktop: false, pro: true },
		],
	},
	{
		title: "AI & collaboration",
		rows: [
			{
				label: "Auto titles, summaries & chapters",
				free: false,
				desktop: false,
				pro: true,
			},
			{ label: "Transcriptions", free: false, desktop: false, pro: true },
			{
				label: "Viewer analytics & engagement",
				free: false,
				desktop: false,
				pro: true,
			},
			{ label: "Team workspaces", free: true, desktop: true, pro: true },
		],
	},
	{
		title: "Security, support & licensing",
		rows: [
			{
				label: "SOC 2 Type II, ISO 27001 & HIPAA compliance",
				free: false,
				desktop: false,
				pro: true,
			},
			{ label: "Community support", free: true, desktop: true, pro: true },
			{
				label: "Priority support & early features",
				free: false,
				desktop: false,
				pro: true,
			},
			{
				label: "License",
				free: "Personal use",
				desktop: "Yearly or lifetime",
				pro: "Subscription",
			},
		],
	},
];

const BUTTON_TEXT: Record<PlanKey, string> = {
	free: "Download",
	desktop: "Get license",
	pro: "Get Cap Pro",
};

const BTN_BASE =
	"inline-flex h-[38px] w-full items-center justify-center rounded-[9px] px-3 text-[13.5px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50";

const BTN_QUIET = `${BTN_BASE} border border-[#D3DCE6] bg-white text-[#111111] hover:bg-[#EDF1F6]`;

const BTN_INK = `${BTN_BASE} bg-[#111111] text-white hover:bg-[#2A2A2A]`;

const PRO_TINT = "rgba(143,193,247,0.12)";

const PlanButton = ({
	plan,
	disabled,
	onClick,
}: {
	plan: Plan;
	disabled: boolean;
	onClick: (key: PlanKey) => void;
}) => (
	<button
		type="button"
		disabled={disabled}
		onClick={() => onClick(plan.key)}
		className={plan.key === "pro" ? BTN_INK : BTN_QUIET}
	>
		{BUTTON_TEXT[plan.key]}
	</button>
);

const Cell = ({
	value,
	compact = false,
}: {
	value: FeatureValue;
	compact?: boolean;
}) => {
	if (typeof value === "string") {
		return (
			<span
				className={classNames(
					"text-[#111111]",
					compact ? "text-[11px] leading-[1.25]" : "text-[13.5px]",
				)}
			>
				{value}
			</span>
		);
	}
	return value ? (
		<>
			<span
				className="grid size-5 place-items-center rounded-full"
				style={{
					background: MODE_THEME.instant.chip,
					color: MODE_THEME.instant.glyph,
				}}
			>
				<Check className="size-3" strokeWidth={2.5} />
			</span>
			<span className="sr-only">Included</span>
		</>
	) : (
		<>
			<span
				aria-hidden="true"
				className="block h-px w-3 rounded-full bg-[rgba(17,17,17,0.2)]"
			/>
			<span className="sr-only">Not included</span>
		</>
	);
};

export const ComparePlans = () => {
	const user = useCurrentUser();
	const { symbol } = useCurrency();
	const stripeCtx = useStripeContext();
	const [loading, setLoading] = useState(false);

	const disabled = Boolean((user?.email && user.isPro) || loading);

	const plans: Plan[] = useMemo(
		() => [
			{
				key: "free",
				name: "Free",
				short: "Free",
				price: "Free forever",
				compactPrice: "$0",
			},
			{
				key: "desktop",
				name: "Desktop License",
				short: "Desktop",
				price: `${symbol}${PRICING.commercial.yearly} per year`,
				compactPrice: `${symbol}${PRICING.commercial.yearly}/yr`,
			},
			{
				key: "pro",
				name: "Cap Pro",
				short: "Pro",
				price: `${symbol}${PRICING.pro.monthly} per user / mo`,
				compactPrice: `${symbol}${PRICING.pro.monthly}/user/mo`,
			},
		],
		[symbol],
	);

	const postCheckout = async (
		url: string,
		body: Record<string, unknown>,
		errorMessage: string,
	) => {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = await response.json();
		if (response.ok && data.url) {
			window.location.href = data.url;
			return;
		}
		throw new Error(data.message || errorMessage);
	};

	const proCheckout = async () => {
		const priceId = stripeCtx.plans.monthly;
		const response = await fetch("/api/settings/billing/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ priceId, quantity: 1 }),
		});
		const data = await response.json();

		if (data.auth === false) {
			await postCheckout(
				"/api/settings/billing/guest-checkout",
				{ priceId, quantity: 1 },
				"Failed to create checkout session",
			);
			return;
		}
		if (data.subscription === true) {
			toast.success("You are already on the Cap Pro plan");
			return;
		}
		if (data.url) {
			window.location.href = data.url;
		}
	};

	const handlePlanClick = async (key: PlanKey) => {
		trackEvent("pricing_cta_clicked", {
			source_page: "pricing_compare",
			plan_name: key,
			authenticated: Boolean(user?.email),
			is_pro: Boolean(user?.isPro),
			cta_action:
				key === "free"
					? "download"
					: key === "desktop"
						? "commercial_checkout"
						: user?.email
							? "checkout"
							: "guest_checkout",
			target_billing_period: key === "pro" ? "monthly" : null,
		});

		if (key === "free") {
			window.location.href = "/download";
			return;
		}

		setLoading(true);
		try {
			if (key === "desktop") {
				await postCheckout(
					"/api/commercial/checkout",
					{ type: "yearly", quantity: 1 },
					"Failed to start checkout process",
				);
			} else {
				await proCheckout();
			}
		} catch (error) {
			console.error("Checkout error:", error);
			toast.error(
				key === "desktop"
					? "Failed to start checkout process"
					: "Failed to start subscription process",
			);
		} finally {
			setLoading(false);
		}
	};

	return (
		<section className="px-5 py-20 lg:py-28">
			<div className="mx-auto max-w-[1060px]">
				<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
					<h2
						className={`${H_SECTION} text-balance text-[clamp(34px,4.6vw,56px)]`}
					>
						Every plan, side by side
					</h2>
					<p
						className={`${BODY_TEXT} mt-6 max-w-[520px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
					>
						Free covers personal use with no time limit on local recordings.
						Paid plans add commercial rights, and Cap Pro adds the cloud.
					</p>
				</div>

				<div className="mt-14 hidden rounded-[22px] bg-white p-3 shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_24px_48px_-32px_rgba(17,17,17,0.2)] md:block">
					<table className="w-full table-fixed border-separate border-spacing-0">
						<thead>
							<tr className="align-bottom">
								<th className="w-[37%] px-5 pb-5" />
								{plans.map((plan) => {
									const pro = plan.key === "pro";
									return (
										<th
											key={plan.key}
											className={classNames(
												"w-[21%] px-4 pb-5 pt-6 text-left align-bottom font-normal",
												pro && "rounded-t-[16px]",
											)}
											style={pro ? { background: PRO_TINT } : undefined}
										>
											<p className="text-[16px] font-medium leading-none tracking-[-0.01em] text-[#111111]">
												{plan.name}
											</p>
											<p className="mt-2 mb-4 text-[13px] text-[rgba(17,17,17,0.5)]">
												{plan.price}
											</p>
											<PlanButton
												plan={plan}
												disabled={disabled}
												onClick={handlePlanClick}
											/>
										</th>
									);
								})}
							</tr>
						</thead>
						<tbody>
							{sections.map((section) => (
								<Fragment key={section.title}>
									<tr>
										<td
											className={`${MONO} px-5 pb-3 pt-8 text-[11.5px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.5)]`}
										>
											{section.title}
										</td>
										<td />
										<td />
										<td style={{ background: PRO_TINT }} />
									</tr>
									{section.rows.map((row) => (
										<tr key={row.label}>
											<td className="border-t border-[#E1E7EE] px-5 py-3.5 text-[14.5px] text-[rgba(17,17,17,0.78)]">
												{row.label}
											</td>
											{plans.map((plan) => (
												<td
													key={plan.key}
													className="border-t border-[#E1E7EE] px-4 py-3.5"
													style={
														plan.key === "pro"
															? { background: PRO_TINT }
															: undefined
													}
												>
													<span className="flex items-center">
														<Cell value={row[plan.key]} />
													</span>
												</td>
											))}
										</tr>
									))}
								</Fragment>
							))}
							<tr>
								<td className="h-5" />
								<td />
								<td />
								<td
									className="rounded-b-[16px]"
									style={{ background: PRO_TINT }}
								/>
							</tr>
						</tbody>
					</table>
				</div>

				<div className="mt-10 md:hidden">
					<div className="sticky top-[72px] z-[5] -mx-5 border-b border-[#E1E7EE] bg-[#F8FAFC] px-5">
						<div className="flex items-end gap-1 py-3">
							<span className="flex-1 text-[12px] text-[rgba(17,17,17,0.5)]">
								Feature
							</span>
							{plans.map((plan) => (
								<span
									key={plan.key}
									className="w-[52px] text-center min-[360px]:w-[58px]"
								>
									<span className="block text-[13px] font-medium leading-none text-[#111111]">
										{plan.short}
									</span>
									<span className="mt-1 block text-[10.5px] leading-none text-[rgba(17,17,17,0.5)]">
										{plan.compactPrice}
									</span>
								</span>
							))}
						</div>
					</div>

					{sections.map((section) => (
						<div key={section.title}>
							<p
								className={`${MONO} pb-2 pt-7 text-[11px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.5)]`}
							>
								{section.title}
							</p>
							<div className="divide-y divide-[#E1E7EE] border-y border-[#E1E7EE]">
								{section.rows.map((row) => (
									<div
										key={row.label}
										className="flex items-center gap-1 py-2.5"
									>
										<span className="flex-1 pr-2 text-[13.5px] leading-snug text-[rgba(17,17,17,0.78)]">
											{row.label}
										</span>
										{plans.map((plan) => (
											<span
												key={plan.key}
												className="flex min-h-[36px] w-[52px] items-center justify-center rounded-[8px] px-0.5 text-center min-[360px]:w-[58px]"
												style={
													plan.key === "pro"
														? { background: PRO_TINT }
														: undefined
												}
											>
												<Cell value={row[plan.key]} compact />
											</span>
										))}
									</div>
								))}
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
};

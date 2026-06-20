"use client";

import { Button } from "@cap/ui";
import { classNames } from "@cap/utils";
import { faCheck } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { useStripeContext } from "@/app/Layout/StripeContext";
import { trackEvent } from "@/app/utils/analytics";

type PlanKey = "free" | "desktop" | "pro";

type Plan = {
	key: PlanKey;
	name: string;
	short: string;
	price: string;
	href?: string;
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
		title: "Support & licensing",
		rows: [
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
				desktop: "Perpetual",
				pro: "Subscription",
			},
		],
	},
];

const getButtonVariant = (key: PlanKey) => {
	switch (key) {
		case "pro":
			return "blue" as const;
		default:
			return "outline" as const;
	}
};

const getButtonText = (key: PlanKey): string => {
	switch (key) {
		case "free":
			return "Download";
		case "desktop":
			return "Get license";
		default:
			return "Get started";
	}
};

export const ComparePlans = () => {
	const user = useCurrentUser();
	const [proLoading, setProLoading] = useState(false);
	const [guestLoading, setGuestLoading] = useState(false);
	const [commercialLoading, setCommercialLoading] = useState(false);
	const stripeCtx = useStripeContext();

	const isDisabled = useMemo(
		() =>
			Boolean(
				(user?.email && user.isPro) ||
					proLoading ||
					guestLoading ||
					commercialLoading,
			),
		[user, proLoading, guestLoading, commercialLoading],
	);

	const plans: Plan[] = useMemo(
		() => [
			{
				key: "free",
				name: "Free",
				short: "Free",
				price: "Free forever",
				href: "/download",
			},
			{
				key: "desktop",
				name: "Desktop License",
				short: "Desktop",
				price: "$29/yr",
			},
			{ key: "pro", name: "Cap Pro", short: "Pro", price: "$8.16/user/mo" },
		],
		[],
	);

	const handleCheckout = async (
		url: string,
		body: Record<string, unknown>,
		setLoading: (loading: boolean) => void,
		errorMessage: string,
	) => {
		setLoading(true);
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			const data = await response.json();

			if (response.ok && data.url) {
				window.location.href = data.url;
			} else {
				throw new Error(data.message || errorMessage);
			}
		} catch (error) {
			console.error("Checkout error:", error);
			toast.error(errorMessage);
		} finally {
			setLoading(false);
		}
	};

	const guestCheckout = (planId: string) =>
		handleCheckout(
			"/api/settings/billing/guest-checkout",
			{ priceId: planId, quantity: 1 },
			setGuestLoading,
			"Failed to create checkout session",
		);

	const openCommercialCheckout = () =>
		handleCheckout(
			"/api/commercial/checkout",
			{ type: "lifetime", quantity: 1 },
			setCommercialLoading,
			"Failed to start checkout process",
		);

	const planCheckout = async (planId?: string) => {
		const finalPlanId = planId || stripeCtx.plans.monthly;
		setProLoading(true);

		try {
			const response = await fetch("/api/settings/billing/subscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ priceId: finalPlanId, quantity: 1 }),
			});

			const data = await response.json();

			if (data.auth === false) {
				setProLoading(false);
				await guestCheckout(finalPlanId);
				return;
			}

			if (data.subscription === true) {
				toast.success("You are already on the Cap Pro plan");
				return;
			}

			if (data.url) {
				window.location.href = data.url;
			}
		} catch (error) {
			console.error("Plan checkout error:", error);
			toast.error("Failed to start subscription process");
		} finally {
			setProLoading(false);
		}
	};

	const handlePlanClick = (key: PlanKey) => {
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
		} else if (key === "desktop") {
			openCommercialCheckout();
		} else {
			planCheckout();
		}
	};

	const renderCell = (value: FeatureValue) => {
		if (typeof value === "boolean") {
			return value ? (
				<>
					<FontAwesomeIcon
						className="text-blue-500 size-3.5"
						icon={faCheck}
						aria-hidden="true"
					/>
					<span className="sr-only">Included</span>
				</>
			) : (
				<>
					<span className="text-gray-8" aria-hidden="true">
						—
					</span>
					<span className="sr-only">Not included</span>
				</>
			);
		}
		return <span className="text-sm text-gray-12">{value}</span>;
	};

	return (
		<div className="mx-auto w-full max-w-[960px]">
			<h2 className="mb-3 text-3xl font-medium tracking-tight text-center md:text-4xl text-gray-12">
				Compare plans
			</h2>
			<p className="mx-auto mb-12 max-w-md text-center text-gray-10">
				Everything you get with Free, Desktop License, and Cap Pro.
			</p>

			<div className="hidden p-4 rounded-2xl border shadow-sm md:block bg-gray-1 border-gray-5">
				<div className="overflow-x-auto">
					<table className="w-full border-separate table-fixed border-spacing-0 min-w-[640px]">
						<thead>
							<tr className="align-bottom">
								<th className="px-5 pb-6 w-[40%] border-b border-gray-3" />
								{plans.map((plan) => {
									const isPro = plan.key === "pro";
									return (
										<th
											key={plan.key}
											className={classNames(
												"px-3 pt-6 pb-6 w-[20%] font-normal text-center align-bottom",
												isPro
													? "border-t-2 border-x-2 rounded-t-2xl border-blue-500"
													: "border-b border-gray-3",
											)}
										>
											<p className="text-base font-semibold text-gray-12">
												{plan.name}
											</p>
											<p className="mt-1 mb-4 text-sm text-gray-10">
												{plan.price}
											</p>
											<Button
												disabled={isDisabled}
												onClick={() => handlePlanClick(plan.key)}
												size="sm"
												variant={getButtonVariant(plan.key)}
												className="w-full"
											>
												{getButtonText(plan.key)}
											</Button>
										</th>
									);
								})}
							</tr>
						</thead>
						<tbody>
							{sections.map((section) => (
								<Fragment key={section.title}>
									<tr>
										<td className="px-5 pt-8 pb-3 text-sm font-semibold text-gray-12">
											{section.title}
										</td>
										<td className="pt-8 pb-3" />
										<td className="pt-8 pb-3" />
										<td className="px-3 pt-8 pb-3 border-x-2 border-blue-500" />
									</tr>
									{section.rows.map((row) => (
										<tr key={row.label}>
											<td className="px-5 py-3.5 text-sm border-t border-gray-3 text-gray-11">
												{row.label}
											</td>
											<td className="px-3 py-3.5 text-center border-t border-gray-3">
												{renderCell(row.free)}
											</td>
											<td className="px-3 py-3.5 text-center border-t border-gray-3">
												{renderCell(row.desktop)}
											</td>
											<td className="px-3 py-3.5 text-center border-t border-x-2 border-blue-500 border-t-blue-500/10">
												{renderCell(row.pro)}
											</td>
										</tr>
									))}
								</Fragment>
							))}
							<tr>
								<td />
								<td />
								<td />
								<td className="h-4 border-b-2 border-x-2 rounded-b-2xl border-blue-500" />
							</tr>
						</tbody>
					</table>
				</div>
			</div>

			<div className="space-y-8 md:hidden">
				<div className="grid grid-cols-3 gap-2">
					{plans.map((plan) => {
						const isPro = plan.key === "pro";
						return (
							<div
								key={plan.key}
								className={classNames(
									"flex flex-col p-3 text-center rounded-xl bg-gray-1",
									isPro ? "ring-2 ring-blue-500" : "border border-gray-5",
								)}
							>
								<p className="text-sm font-semibold text-gray-12">
									{plan.short}
								</p>
								<p className="mt-0.5 mb-3 text-[11px] text-gray-10">
									{plan.price}
								</p>
								<Button
									disabled={isDisabled}
									onClick={() => handlePlanClick(plan.key)}
									size="xs"
									variant={getButtonVariant(plan.key)}
									className="px-2 mt-auto w-full text-xs"
								>
									{getButtonText(plan.key)}
								</Button>
							</div>
						);
					})}
				</div>

				{sections.map((section) => (
					<div key={section.title}>
						<p className="mb-3 text-sm font-medium text-gray-12">
							{section.title}
						</p>
						<div className="space-y-3">
							{section.rows.map((row) => (
								<div key={row.label}>
									<p className="mb-1.5 text-sm text-gray-11">{row.label}</p>
									<div className="grid grid-cols-3 gap-2">
										{plans.map((plan) => {
											const isPro = plan.key === "pro";
											return (
												<div
													key={plan.key}
													className={classNames(
														"flex flex-col gap-1 justify-center items-center px-1.5 py-2 text-center rounded-lg min-h-[52px]",
														isPro ? "bg-blue-2" : "bg-gray-2",
													)}
												>
													<span className="text-[10px] font-medium tracking-wide uppercase text-gray-9">
														{plan.short}
													</span>
													<span className="flex justify-center items-center text-sm">
														{renderCell(row[plan.key])}
													</span>
												</div>
											);
										})}
									</div>
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
};

export default ComparePlans;

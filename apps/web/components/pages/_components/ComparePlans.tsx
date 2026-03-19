"use client";

import { Button } from "@cap/ui";
import { faCheckCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { clsx } from "clsx";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { useStripeContext } from "@/app/Layout/StripeContext";
import {
	CommercialArt,
	type CommercialArtRef,
} from "../HomePage/Pricing/CommercialArt";
import { ProArt, type ProArtRef } from "../HomePage/Pricing/ProArt";

const COLUMN_WIDTH = "min-w-[200px]";

type Plan = {
	name: string;
	price: string;
	href?: string;
	disabled?: boolean;
};

const getButtonText = (planName: string): string => {
	switch (planName) {
		case "Free":
			return "Download for free";
		case "Desktop License":
			return "Get Desktop License";
		case "Cap Pro":
			return "Get started";
		default:
			return "Get started";
	}
};

const getButtonVariant = (planName: string) => {
	switch (planName) {
		case "Free":
			return "gray";
		case "Desktop License":
			return "dark";
		case "Cap Pro":
			return "blue";
		default:
			return "gray";
	}
};

// Icon component renderer
const PlanIcon = ({
	planName,
	commercialArtRef,
	proArtRef,
}: {
	planName: string;
	commercialArtRef: React.RefObject<CommercialArtRef | null>;
	proArtRef: React.RefObject<ProArtRef | null>;
}) => {
	if (planName === "Desktop License") {
		return (
			<div
				onMouseEnter={() => commercialArtRef.current?.playHoverAnimation()}
				onMouseLeave={() => commercialArtRef.current?.playDefaultAnimation()}
				className="w-[90px] h-[80px]"
			>
				<CommercialArt className="w-[80px] h-[80px]" ref={commercialArtRef} />
			</div>
		);
	}

	if (planName === "Cap Pro") {
		return (
			<div
				onMouseEnter={() => proArtRef.current?.playHoverAnimation()}
				onMouseLeave={() => proArtRef.current?.playDefaultAnimation()}
				className="w-[90px] ml-2 h-[80px]"
			>
				<ProArt ref={proArtRef} className="w-16 h-[98px]" />
			</div>
		);
	}

	return null;
};

export const ComparePlans = () => {
	const commercialArtRef = useRef<CommercialArtRef>(null);
	const proArtRef = useRef<ProArtRef>(null);
	const user = useCurrentUser();
	const [proLoading, setProLoading] = useState(false);
	const [guestLoading, setGuestLoading] = useState(false);
	const [commercialLoading, setCommercialLoading] = useState(false);
	const stripeCtx = useStripeContext();

	// Check if user is already pro or any loading state is active
	const isDisabled = useMemo(
		() =>
			(user?.email && user.isPro) ||
			proLoading ||
			guestLoading ||
			commercialLoading,
		[user, proLoading, guestLoading, commercialLoading],
	);

	const plans: Plan[] = useMemo(
		() => [
			{
				name: "Free",
				price: "$0 forever",
				href: "/login",
				disabled: isDisabled,
			},
			{
				name: "Desktop License",
				price: "$58 /lifetime or $29 /year",
				disabled: isDisabled,
			},
			{
				name: "Cap Pro",
				price:
					"$8.16 /mo per user, billed annually or $12 /mo per user, billed monthly",
				disabled: isDisabled,
			},
		],
		[isDisabled],
	);
	// Feature comparison data
	const rows = useMemo(
		() => [
			{ label: "Unlimited recordings", free: false, desktop: true, pro: true },
			{ label: "Commercial usage", free: false, desktop: true, pro: true },
			{
				label: "Studio Mode with full editor",
				free: true,
				desktop: true,
				pro: true,
			},
			{ label: "Export to any format", free: true, desktop: true, pro: true },
			{ label: "4K export", free: true, desktop: true, pro: true },
			{
				label: "Cloud storage & bandwidth",
				free: false,
				desktop: false,
				pro: "Unlimited",
			},
			{
				label: "Auto-generated titles & summaries",
				free: false,
				desktop: false,
				pro: true,
			},
			{
				label: "Clickable chapters & transcriptions",
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
				label: "Viewer analytics & engagement",
				free: false,
				desktop: false,
				pro: true,
			},
			{ label: "Team workspaces", free: true, desktop: true, pro: true },
			{
				label: "Loom video importer",
				free: false,
				desktop: false,
				pro: true,
			},
			{
				label: "Custom S3 bucket support",
				free: false,
				desktop: false,
				pro: true,
			},
			{ label: "Priority support", free: false, desktop: false, pro: true },
			{
				label: "Early features access",
				free: false,
				desktop: false,
				pro: true,
			},
			{ label: "Community support", free: true, desktop: true, pro: true },
			{
				label: "License type",
				free: "Free",
				desktop: "Perpetual (single device)",
				pro: "Subscription",
			},
		],
		[],
	);

	// Generic checkout handler with error handling
	const handleCheckout = async (
		url: string,
		body: Record<string, any>,
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
		const finalPlanId = planId || stripeCtx.plans.yearly;
		setProLoading(true);

		try {
			const response = await fetch("/api/settings/billing/subscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ priceId: finalPlanId, quantity: 1 }),
			});

			const data = await response.json();

			if (data.auth === false) {
				// User not authenticated, do guest checkout
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

	const renderCell = (value: boolean | string) => {
		if (typeof value === "boolean") {
			return value ? (
				<FontAwesomeIcon
					className="text-emerald-500 size-4"
					icon={faCheckCircle}
				/>
			) : (
				<span className="text-gray-8">—</span>
			);
		}
		return <span className="text-gray-12">{value}</span>;
	};
	return (
		<div className="mx-auto w-full max-w-[1400px]">
			<h2 className="mb-6 text-4xl text-center text-gray-12">Compare plans</h2>
			<div className="overflow-x-auto w-full">
				<div className="overflow-hidden rounded-xl border min-w-fit border-gray-5">
					<table className="w-full text-left border-separate border-spacing-0 bg-gray-2">
						<thead>
							<tr className="bg-gray-1">
								<th
									className={clsx(
										"px-4 text-sm font-medium text-gray-12",
										COLUMN_WIDTH,
									)}
								/>
								{plans.map((plan) => (
									<th
										key={plan.name}
										className={clsx(
											"px-4 py-6 text-sm font-semibold text-gray-12",
											COLUMN_WIDTH,
										)}
									>
										<div className="flex flex-1 gap-2">
											<div className="flex-shrink-0">
												<PlanIcon
													planName={plan.name}
													commercialArtRef={commercialArtRef}
													proArtRef={proArtRef}
												/>
											</div>
											<div className="flex flex-col flex-1 justify-center text-black">
												<p className="text-sm font-semibold text-gray-12">
													{plan.name}
												</p>
												<p className="mt-1 text-[15px] w-full min-w-[250px] max-w-[250px] font-medium text-gray-10">
													{plan.price}
												</p>
											</div>
										</div>
									</th>
								))}
							</tr>
							<tr className="bg-gray-1">
								<th
									className={clsx(
										"px-4 pb-4 text-xs font-medium text-transparent border-b border-gray-5",
										COLUMN_WIDTH,
									)}
								>
									.
								</th>
								{plans.map((plan) => (
									<th
										key={`${plan.name}-cta`}
										className={clsx(
											"px-4 pb-6 border-b border-gray-5",
											COLUMN_WIDTH,
										)}
									>
										<div className="space-y-2">
											<Button
												disabled={plan.disabled}
												href={plan.name === "Free" ? plan.href : undefined}
												className="w-fit"
												onClick={() => {
													if (plan.name === "Free") {
														window.location.href = "/download";
													}
													if (plan.name === "Desktop License") {
														openCommercialCheckout();
													} else {
														planCheckout();
													}
												}}
												size="sm"
												variant={getButtonVariant(plan.name)}
											>
												{getButtonText(plan.name)}
											</Button>
										</div>
									</th>
								))}
							</tr>
						</thead>
						<tbody className="[&>tr+tr>td]:border-t [&>tr+tr>td]:border-gray-5">
							{rows.map((row) => (
								<tr key={row.label} className="bg-gray-2">
									<td
										className={clsx(
											"p-5 text-sm font-medium text-nowrap text-gray-11",
											COLUMN_WIDTH,
										)}
									>
										{row.label}
									</td>
									<td className={clsx("px-4 py-3 text-sm", COLUMN_WIDTH)}>
										{renderCell(row.free)}
									</td>
									<td className={clsx("px-4 py-3 text-sm", COLUMN_WIDTH)}>
										{renderCell(row.desktop)}
									</td>
									<td className={clsx("px-4 py-3 text-sm", COLUMN_WIDTH)}>
										{renderCell(row.pro)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
};

export default ComparePlans;

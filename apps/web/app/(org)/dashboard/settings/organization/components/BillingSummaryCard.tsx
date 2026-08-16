"use client";

import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	getSubscriptionDetails,
	type SubscriptionDetails,
} from "@/actions/organization/get-subscription-details";
import { manageBilling } from "@/actions/organization/manage-billing";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { formatAmount } from "@/utils/currency";

export function BillingSummaryCard() {
	const { activeOrganization, setUpgradeModalOpen } = useDashboardContext();
	const router = useRouter();
	const [billingLoading, setBillingLoading] = useState(false);
	const organizationId = activeOrganization?.organization.id;

	const {
		data: subscription,
		isLoading,
		isError,
	} = useQuery<SubscriptionDetails | null>({
		queryKey: ["subscription-details", organizationId],
		queryFn: () => {
			if (!organizationId) return null;
			return getSubscriptionDetails(organizationId);
		},
		enabled: !!organizationId,
		staleTime: 60 * 1000,
	});

	const handleManageBilling = useCallback(async () => {
		setBillingLoading(true);
		try {
			const url = await manageBilling();
			router.push(url);
		} catch {
			toast.error("An error occurred while managing billing");
		} finally {
			setBillingLoading(false);
		}
	}, [router]);

	if (isLoading) {
		return (
			<Card>
				<div className="flex flex-col gap-3 animate-pulse">
					<div className="h-5 w-32 bg-gray-4 rounded" />
					<div className="h-4 w-48 bg-gray-4 rounded" />
					<div className="h-4 w-40 bg-gray-4 rounded" />
				</div>
			</Card>
		);
	}

	if (isError) {
		return (
			<Card>
				<p className="text-sm text-gray-10">
					Unable to load billing details. Please try again later.
				</p>
			</Card>
		);
	}

	if (!subscription) {
		return (
			<Card className="flex flex-wrap gap-6 justify-between items-center w-full">
				<CardHeader>
					<CardTitle>Upgrade to Cap Pro</CardTitle>
					<CardDescription>
						Get unlimited sharing, custom domains, Cap AI, and more.
					</CardDescription>
				</CardHeader>
				<Button
					type="button"
					size="sm"
					variant="primary"
					onClick={() => setUpgradeModalOpen(true)}
				>
					Upgrade to Pro
				</Button>
			</Card>
		);
	}

	const pastDue = subscription.status === "past_due";
	const statusLabel = pastDue
		? "Payment failed"
		: subscription.status === "trialing"
			? "Trialing"
			: "Active";
	const intervalLabel =
		subscription.billingInterval === "year" ? "annually" : "monthly";
	const totalAmount = subscription.pricePerSeat * subscription.currentQuantity;
	const seatAmountLabel = formatAmount(
		subscription.pricePerSeat,
		subscription.currency,
	);
	const totalAmountLabel = formatAmount(totalAmount, subscription.currency);
	const nextBillingDate = format(
		new Date(subscription.currentPeriodEnd * 1000),
		"MMM d, yyyy",
	);

	return (
		<Card>
			<div className="flex flex-wrap gap-6 justify-between items-center w-full">
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-3">
						<h3 className="text-lg font-semibold text-gray-12">
							{subscription.planName}
						</h3>
						<span
							className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
								pastDue ? "bg-red-100 text-red-700" : "bg-gray-4 text-gray-11"
							}`}
						>
							{statusLabel}
						</span>
					</div>
					<div className="flex flex-col gap-1 text-sm text-gray-11">
						<p>
							{seatAmountLabel}/seat/mo ({subscription.currentQuantity}{" "}
							{subscription.currentQuantity === 1 ? "seat" : "seats"} ={" "}
							{totalAmountLabel}/mo, billed {intervalLabel})
						</p>
						{pastDue ? (
							<p className="text-red-700">
								Your last payment failed. Update your payment method to keep Pro
								active; we'll keep retrying in the meantime.
							</p>
						) : (
							<p>Next billing date: {nextBillingDate}</p>
						)}
					</div>
				</div>
				<Button
					type="button"
					size="sm"
					variant="dark"
					spinner={billingLoading}
					onClick={handleManageBilling}
					disabled={billingLoading}
				>
					{billingLoading ? "Loading..." : "Manage Billing"}
				</Button>
			</div>
		</Card>
	);
}

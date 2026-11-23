"use client";

import { Button } from "@cap/ui";
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
import { PlanDoodle } from "../_components/doodles";
import { SettingsRow, StatusChip } from "../_components/settings-ui";

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

	const icon = <PlanDoodle />;

	if (isLoading) {
		return (
			<SettingsRow
				icon={icon}
				title="Cap Pro"
				description="Loading your plan..."
			/>
		);
	}

	if (isError) {
		return (
			<SettingsRow
				icon={icon}
				title="Plan"
				description="Unable to load billing details. Please try again later."
			/>
		);
	}

	if (!subscription) {
		return (
			<SettingsRow
				icon={icon}
				title="Upgrade to Cap Pro"
				description="Get unlimited sharing, custom domains, Cap AI, and more."
				control={
					<Button
						type="button"
						size="xs"
						variant="dark"
						className="px-4"
						onClick={() => setUpgradeModalOpen(true)}
					>
						Upgrade to Pro
					</Button>
				}
			/>
		);
	}

	const pastDue = subscription.status === "past_due";
	const canceling = subscription.cancelAtPeriodEnd && !pastDue;
	const statusLabel = pastDue
		? "Payment failed"
		: canceling
			? "Canceling"
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
		<SettingsRow
			icon={icon}
			title={subscription.planName}
			meta={
				<StatusChip
					tone={pastDue ? "danger" : canceling ? "warning" : "positive"}
				>
					{statusLabel}
				</StatusChip>
			}
			description={
				<>
					{seatAmountLabel}/seat/mo · {subscription.currentQuantity}{" "}
					{subscription.currentQuantity === 1 ? "seat" : "seats"} ·{" "}
					{totalAmountLabel}/mo, billed {intervalLabel}
					<br />
					{pastDue ? (
						<span className="text-red-700">
							Your last payment failed. Update your payment method to keep Pro
							active; we'll keep retrying in the meantime.
						</span>
					) : canceling ? (
						<span className="text-amber-700">
							Your subscription ends on {nextBillingDate}. You keep Pro until
							then; add seats or use Manage billing to resume.
						</span>
					) : (
						<>Next billing date: {nextBillingDate}</>
					)}
				</>
			}
			control={
				<Button
					type="button"
					size="xs"
					variant="outline"
					className="px-4"
					spinner={billingLoading}
					onClick={handleManageBilling}
					disabled={billingLoading}
				>
					{billingLoading ? "Loading..." : "Manage billing"}
				</Button>
			}
		/>
	);
}

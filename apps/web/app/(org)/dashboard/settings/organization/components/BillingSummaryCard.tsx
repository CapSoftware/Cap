"use client";

import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	getSubscriptionDetails,
	type SubscriptionDetails,
} from "@/actions/organization/get-subscription-details";
import { manageBilling } from "@/actions/organization/manage-billing";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";

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
			toast.error("管理账单时发生错误");
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
				<p className="text-sm text-gray-10">无法加载账单详情，请稍后重试。</p>
			</Card>
		);
	}

	if (!subscription) {
		return (
			<Card className="flex flex-wrap gap-6 justify-between items-center w-full">
				<CardHeader>
					<CardTitle>升级到 Cap Pro</CardTitle>
					<CardDescription>
						获得无限分享、自定义域名、Cap AI 等更多功能。
					</CardDescription>
				</CardHeader>
				<Button
					type="button"
					size="sm"
					variant="primary"
					onClick={() => setUpgradeModalOpen(true)}
				>
					升级到 Pro
				</Button>
			</Card>
		);
	}

	const statusLabel = subscription.status === "trialing" ? "试用中" : "有效";
	const intervalLabel =
		subscription.billingInterval === "year" ? "按年计费" : "按月计费";
	const totalAmount = subscription.pricePerSeat * subscription.currentQuantity;
	const nextBillingDate = format(
		new Date(subscription.currentPeriodEnd * 1000),
		"yyyy年M月d日",
		{ locale: zhCN },
	);

	return (
		<Card>
			<div className="flex flex-wrap gap-6 justify-between items-center w-full">
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-3">
						<h3 className="text-lg font-semibold text-gray-12">
							{subscription.planName}
						</h3>
						<span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-4 text-gray-11">
							{statusLabel}
						</span>
					</div>
					<div className="flex flex-col gap-1 text-sm text-gray-11">
						<p>
							每席位每月 ${subscription.pricePerSeat.toFixed(2)}（共{" "}
							{subscription.currentQuantity} 个席位，每月合计 $
							{totalAmount.toFixed(2)}，{intervalLabel}）
						</p>
						<p>下次账单日期：{nextBillingDate}</p>
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
					{billingLoading ? "正在加载…" : "管理账单"}
				</Button>
			</div>
		</Card>
	);
}

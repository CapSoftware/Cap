"use client";

import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
} from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { CreditTransactionTable } from "../_components/CreditTransactionTable";
import { StatBox } from "../_components/StatBox";
import { useDevelopersContext } from "../DevelopersContext";
import type { DeveloperTransaction } from "../developer-data";

const presets = [
	{ label: "$10", cents: 1000 },
	{ label: "$25", cents: 2500 },
	{ label: "$50", cents: 5000 },
];

export function CreditsClient({
	transactions,
}: {
	transactions: DeveloperTransaction[];
}) {
	const { apps } = useDevelopersContext();
	const router = useRouter();
	const searchParams = useSearchParams();
	const [selectedApp, setSelectedApp] = useState(apps[0]?.id ?? "");
	const [customAmount, setCustomAmount] = useState("");

	const app = apps.find((a) => a.id === selectedApp);
	const balance = app?.creditAccount?.balanceMicroCredits ?? 0;

	useEffect(() => {
		if (searchParams.get("purchase") === "success") {
			toast.success("额度购买成功！");
			router.replace("/dashboard/developers/credits");
		}
	}, [searchParams, router]);

	const purchaseMutation = useMutation({
		mutationFn: async (amountCents: number) => {
			const res = await fetch("/api/developer/credits/checkout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ appId: selectedApp, amountCents }),
			});

			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error ?? "无法开始结账");
			}

			const { url } = await res.json();
			window.location.href = url;
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : "购买额度失败");
		},
	});

	return (
		<div className="flex flex-col gap-5">
			<div className="flex items-center justify-between">
				<h2 className="text-base font-medium text-gray-12">额度</h2>
				{apps.length > 1 && (
					<select
						value={selectedApp}
						onChange={(e) => setSelectedApp(e.target.value)}
						className="px-3 py-1.5 text-sm rounded-lg bg-gray-3 border border-gray-6 text-gray-12"
					>
						{apps.map((a) => (
							<option key={a.id} value={a.id}>
								{a.name}
							</option>
						))}
					</select>
				)}
			</div>

			<div className="grid gap-3 sm:grid-cols-3">
				<StatBox label="余额" value={`$${(balance / 100_000).toFixed(2)}`} />
				<StatBox label="录制费率" value="$0.05/分钟" />
				<StatBox label="存储费率" value="$0.001/分钟/月" />
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>购买额度</CardTitle>
						<CardDescription>为你的账户充值额度。</CardDescription>
					</CardHeader>
					<div className="flex flex-wrap gap-2 mt-4">
						{presets.map((preset) => (
							<Button
								key={preset.cents}
								variant="gray"
								size="sm"
								spinner={
									purchaseMutation.isPending &&
									purchaseMutation.variables === preset.cents
								}
								disabled={purchaseMutation.isPending || !selectedApp}
								onClick={() => purchaseMutation.mutate(preset.cents)}
							>
								{preset.label}
							</Button>
						))}
					</div>
					<div className="flex gap-2 items-center mt-3">
						<Input
							value={customAmount}
							onChange={(e) => setCustomAmount(e.target.value)}
							placeholder="$"
							className="w-20"
						/>
						<Button
							variant="dark"
							size="sm"
							disabled={
								!customAmount || purchaseMutation.isPending || !selectedApp
							}
							onClick={() => {
								const cents = Math.round(Number.parseFloat(customAmount) * 100);
								if (cents >= 500) {
									purchaseMutation.mutate(cents);
								} else {
									toast.error("最低购买金额为 $5.00");
								}
							}}
						>
							购买
						</Button>
					</div>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							自动充值
							<span className="text-xs font-normal px-2 py-0.5 rounded-full bg-gray-3 text-gray-11">
								即将推出
							</span>
						</CardTitle>
						<CardDescription>余额低于 $5 时自动充值 $25。</CardDescription>
					</CardHeader>
					<div className="mt-4">
						<Button variant="gray" size="sm" disabled>
							启用自动充值
						</Button>
					</div>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>交易记录</CardTitle>
				</CardHeader>
				<div className="mt-4">
					<CreditTransactionTable transactions={transactions} />
				</div>
			</Card>
		</div>
	);
}

"use client";

import type { DeveloperTransaction } from "../developer-data";

const typeLabels: Record<string, string> = {
	topup: "充值",
	video_create: "录制",
	storage_daily: "存储",
	refund: "退款",
	adjustment: "调整",
};

export function CreditTransactionTable({
	transactions,
}: {
	transactions: DeveloperTransaction[];
}) {
	if (transactions.length === 0) {
		return (
			<p className="py-8 text-sm text-center text-gray-10">暂无交易记录</p>
		);
	}

	return (
		<div className="overflow-x-auto rounded-lg border border-gray-3">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-gray-3 bg-gray-3/50">
						<th className="px-4 py-2.5 text-left text-xs font-medium text-gray-10">
							类型
						</th>
						<th className="px-4 py-2.5 text-right text-xs font-medium text-gray-10">
							金额
						</th>
						<th className="px-4 py-2.5 text-right text-xs font-medium text-gray-10">
							余额
						</th>
						<th className="px-4 py-2.5 text-right text-xs font-medium text-gray-10">
							日期
						</th>
					</tr>
				</thead>
				<tbody>
					{transactions.map((tx) => (
						<tr key={tx.id} className="border-b border-gray-3 last:border-0">
							<td className="px-4 py-2.5 text-gray-12">
								{typeLabels[tx.type] ?? tx.type}
							</td>
							<td
								className={`px-4 py-2.5 text-right tabular-nums ${
									tx.amountMicroCredits >= 0 ? "text-green-400" : "text-red-400"
								}`}
							>
								{tx.amountMicroCredits >= 0 ? "+" : ""}$
								{(Math.abs(tx.amountMicroCredits) / 100_000).toFixed(4)}
							</td>
							<td className="px-4 py-2.5 text-right text-gray-11 tabular-nums">
								${(tx.balanceAfterMicroCredits / 100_000).toFixed(2)}
							</td>
							<td className="px-4 py-2.5 text-right text-gray-10">
								{new Date(tx.createdAt).toLocaleDateString("zh-CN")}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

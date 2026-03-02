"use client";

import type { DeveloperTransaction } from "../developer-data";

const typeLabels: Record<string, string> = {
	topup: "Top Up",
	video_create: "Recording",
	storage_daily: "Storage",
	refund: "Refund",
	adjustment: "Adjustment",
};

export function CreditTransactionTable({
	transactions,
}: {
	transactions: DeveloperTransaction[];
}) {
	if (transactions.length === 0) {
		return (
			<p className="py-8 text-sm text-center text-gray-10">
				No transactions yet
			</p>
		);
	}

	return (
		<div className="overflow-x-auto rounded-lg border border-gray-3">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-gray-3 bg-gray-3/50">
						<th className="px-4 py-2.5 text-left text-xs font-medium text-gray-10">
							Type
						</th>
						<th className="px-4 py-2.5 text-right text-xs font-medium text-gray-10">
							Amount
						</th>
						<th className="px-4 py-2.5 text-right text-xs font-medium text-gray-10">
							Balance
						</th>
						<th className="px-4 py-2.5 text-right text-xs font-medium text-gray-10">
							Date
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
								{new Date(tx.createdAt).toLocaleDateString()}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

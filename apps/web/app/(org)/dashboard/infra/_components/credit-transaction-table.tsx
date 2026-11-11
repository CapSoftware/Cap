import clsx from "clsx";
import { formatCharge, formatCredits } from "@/lib/infra-usage";
import type { DeveloperTransaction } from "../infra-data";

const typeLabels: Record<string, string> = {
	topup: "Top-up",
	video_create: "Video upload",
	storage_daily: "Storage",
	refund: "Refund",
	adjustment: "Adjustment",
};

const dateFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

export function CreditTransactionTable({
	transactions,
}: {
	transactions: DeveloperTransaction[];
}) {
	if (transactions.length === 0) {
		return (
			<p className="py-10 text-sm text-center text-gray-10">
				No transactions yet.
			</p>
		);
	}

	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-gray-3">
						<th className="py-2.5 pr-4 font-normal text-left text-gray-10">
							Date
						</th>
						<th className="px-4 py-2.5 font-normal text-left text-gray-10">
							Type
						</th>
						<th className="px-4 py-2.5 font-normal text-right text-gray-10">
							Amount
						</th>
						<th className="py-2.5 pl-4 font-normal text-right text-gray-10">
							Balance
						</th>
					</tr>
				</thead>
				<tbody>
					{transactions.map((tx) => {
						const credit = tx.amountMicroCredits >= 0;
						return (
							<tr key={tx.id} className="border-b border-gray-3 last:border-0">
								<td className="py-2.5 pr-4 whitespace-nowrap text-gray-11">
									{dateFormat.format(new Date(tx.createdAt))}
								</td>
								<td className="px-4 py-2.5 text-gray-12">
									{typeLabels[tx.type] ?? tx.type}
								</td>
								<td
									className={clsx(
										"px-4 py-2.5 text-right whitespace-nowrap tabular-nums",
										credit ? "text-green-11" : "text-gray-12",
									)}
								>
									{credit ? "+" : "-"}
									{formatCharge(tx.amountMicroCredits)}
								</td>
								<td className="py-2.5 pl-4 text-right whitespace-nowrap tabular-nums text-gray-11">
									{formatCredits(tx.balanceAfterMicroCredits)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

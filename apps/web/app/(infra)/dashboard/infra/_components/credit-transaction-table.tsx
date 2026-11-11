import clsx from "clsx";
import { formatCharge, formatCredits } from "@/lib/infra-usage";
import type { DeveloperTransaction } from "../infra-data";
import { Empty, MONO, TD, TH, TR } from "./ui";

const typeLabels: Record<string, string> = {
	topup: "Top-up",
	video_create: "Video upload",
	storage_daily: "Storage",
	refund: "Refund",
	adjustment: "Adjustment",
	pro_credit: "Cap Pro credit",
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
		return <Empty>No transactions yet.</Empty>;
	}

	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse">
				<thead>
					<tr className={TR}>
						<th className={TH}>Date</th>
						<th className={TH}>Type</th>
						<th className={clsx(TH, "text-right")}>Amount</th>
						<th className={clsx(TH, "text-right")}>Balance</th>
					</tr>
				</thead>
				<tbody>
					{transactions.map((tx) => {
						const credit = tx.amountMicroCredits >= 0;
						return (
							<tr key={tx.id} className={TR}>
								<td className={TD}>
									{dateFormat.format(new Date(tx.createdAt))}
								</td>
								<td className={clsx(TD, "text-[#E8ECF4]")}>
									{typeLabels[tx.type] ?? tx.type}
								</td>
								<td
									className={clsx(
										TD,
										MONO,
										"text-right text-[13px] tabular-nums",
										credit ? "text-white" : "text-[rgba(232,236,244,0.72)]",
									)}
								>
									{credit ? "+" : "-"}
									{formatCharge(tx.amountMicroCredits)}
								</td>
								<td
									className={clsx(
										TD,
										MONO,
										"text-right text-[13px] tabular-nums",
									)}
								>
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

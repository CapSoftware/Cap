import clsx from "clsx";
import {
	describeLedgerRow,
	formatLedgerTime,
	type LedgerRow,
} from "@/lib/infra-ledger";
import { formatCharge, formatCredits } from "@/lib/infra-usage";
import { Empty, MONO, TD, TH, TR } from "./ui";

const DETAIL = "text-[12.5px] leading-[1.45] text-[rgba(232,236,244,0.46)]";

function amountText(microCredits: number) {
	const sign = microCredits === 0 ? "" : microCredits > 0 ? "+" : "-";
	return `${sign}${formatCharge(microCredits)}`;
}

function Detail({ row }: { row: LedgerRow }) {
	const { note, reference } = describeLedgerRow(row);
	if (!note && !reference) return null;
	return (
		<>
			{reference && (
				<span
					className={clsx(DETAIL, "block truncate")}
					title={`${reference.kind} ${reference.value}`}
				>
					{reference.kind}{" "}
					<span className={clsx(MONO, "text-[12px]")}>{reference.value}</span>
				</span>
			)}
			{note && (
				<span className={clsx(DETAIL, "block whitespace-normal text-pretty")}>
					{note}
				</span>
			)}
		</>
	);
}

export function CreditTransactionTable({
	transactions,
}: {
	transactions: LedgerRow[];
}) {
	if (transactions.length === 0) {
		return <Empty>No transactions yet.</Empty>;
	}

	return (
		<>
			<table className="hidden w-full border-collapse md:table">
				<thead>
					<tr className={TR}>
						<th className={TH}>Time (UTC)</th>
						<th className={clsx(TH, "w-full")}>Type</th>
						<th className={TH}>Reference</th>
						<th className={clsx(TH, "text-right")}>Amount</th>
						<th className={clsx(TH, "text-right")}>Balance</th>
					</tr>
				</thead>
				<tbody>
					{transactions.map((tx) => (
						<tr key={tx.id} className={clsx(TR, "align-top")}>
							<td className={clsx(TD, "tabular-nums")}>
								<time dateTime={new Date(tx.createdAt).toISOString()}>
									{formatLedgerTime(tx.createdAt)}
								</time>
							</td>
							<td className={clsx(TD, "w-full max-w-0 text-[#E8ECF4]")}>
								{describeLedgerRow(tx).label}
								<Detail row={tx} />
							</td>
							<td className={clsx(TD, MONO, "text-[12.5px]")}>{tx.id}</td>
							<td
								className={clsx(
									TD,
									MONO,
									"text-right text-[13px] tabular-nums",
									tx.amountMicroCredits > 0
										? "text-white"
										: "text-[rgba(232,236,244,0.72)]",
								)}
							>
								{amountText(tx.amountMicroCredits)}
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
					))}
				</tbody>
			</table>

			<ul className="m-0 list-none p-0 md:hidden">
				{transactions.map((tx) => (
					<li key={tx.id} className={clsx(TR, "py-3.5")}>
						<div className="flex items-baseline justify-between gap-4">
							<span className="min-w-0 text-[13.5px] text-[#E8ECF4]">
								{describeLedgerRow(tx).label}
							</span>
							<span
								className={clsx(
									MONO,
									"shrink-0 text-[13px] tabular-nums",
									tx.amountMicroCredits > 0
										? "text-white"
										: "text-[rgba(232,236,244,0.72)]",
								)}
							>
								{amountText(tx.amountMicroCredits)}
							</span>
						</div>
						<div className="mt-1 flex items-baseline justify-between gap-4">
							<time
								dateTime={new Date(tx.createdAt).toISOString()}
								className="min-w-0 text-[12.5px] tabular-nums text-[rgba(232,236,244,0.58)]"
							>
								{formatLedgerTime(tx.createdAt)} UTC
							</time>
							<span
								className={clsx(
									MONO,
									"shrink-0 text-[13px] tabular-nums text-[rgba(232,236,244,0.72)]",
								)}
							>
								<span className="sr-only">Balance </span>
								{formatCredits(tx.balanceAfterMicroCredits)}
							</span>
						</div>
						<div className="mt-1 min-w-0">
							<Detail row={tx} />
							<span className={clsx(DETAIL, "block truncate")}>
								Reference{" "}
								<span className={clsx(MONO, "text-[12px]")}>{tx.id}</span>
							</span>
						</div>
					</li>
				))}
			</ul>
		</>
	);
}

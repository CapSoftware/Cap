import clsx from "clsx";
import type { Metadata } from "next";
import {
	DELIVERY_DOLLARS_PER_1000_MINUTES,
	SPEECH_DOLLARS_PER_HOUR,
	STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
	UPLOAD_DOLLARS_PER_MINUTE,
} from "@/lib/developer-pricing";
import { formatCredits } from "@/lib/infra-usage";
import { CreditTransactionTable } from "../../_components/credit-transaction-table";
import { ProCredit } from "../../_components/pro-credit";
import { Block, MONO, PageHeader } from "../../_components/ui";
import {
	getDeveloperTransactions,
	getInfraProCredit,
	requireInfraApp,
} from "../../infra-data";
import { TopUp } from "./top-up";

export const metadata: Metadata = {
	title: "Billing | Cap Infra",
};

const dollars = (value: number) => `$${value.toFixed(2)}`;

const rates = [
	{
		name: "Upload",
		price: dollars(UPLOAD_DOLLARS_PER_MINUTE),
		unit: "per minute uploaded",
	},
	{
		name: "Storage",
		price: dollars(STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH),
		unit: "per 1,000 minutes stored per month",
	},
	{
		name: "Delivery",
		price: dollars(DELIVERY_DOLLARS_PER_1000_MINUTES),
		unit: "per 1,000 minutes watched",
	},
	{
		name: "Speech to text",
		price: dollars(SPEECH_DOLLARS_PER_HOUR),
		unit: "per audio hour",
	},
];

export default async function InfraBillingPage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app } = await requireInfraApp(appId);
	const [transactions, proCredit] = await Promise.all([
		app.creditAccount
			? getDeveloperTransactions(app.creditAccount.id)
			: Promise.resolve([]),
		getInfraProCredit(),
	]);
	const balance = app.creditAccount?.balanceMicroCredits ?? 0;

	return (
		<>
			<PageHeader
				title="Billing"
				description={`Prepaid credits for ${app.name}. Usage is drawn from this balance.`}
			/>

			<div className="grid gap-x-16 gap-y-12 border-t border-[rgba(222,230,246,0.08)] pt-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<section className="min-w-0">
					<p className="m-0 text-[13px] text-[rgba(232,236,244,0.5)]">
						Credit balance
					</p>
					<p
						className={clsx(
							MONO,
							"m-0 mt-3 text-[44px] leading-none tracking-[-0.045em] tabular-nums text-white",
						)}
					>
						{formatCredits(balance)}
					</p>
					<div className="mt-9">
						{app.creditAccount ? (
							<>
								<TopUp appId={app.id} />
								<div className="mt-8 border-t border-[rgba(222,230,246,0.08)] pt-6">
									<ProCredit appId={app.id} credit={proCredit} />
								</div>
							</>
						) : (
							<p className="m-0 text-[14px] leading-[1.55] text-[rgba(232,236,244,0.58)]">
								This app has no credit account, so it cannot be topped up.
							</p>
						)}
					</div>
				</section>

				<Block title="Rates">
					<dl className="m-0">
						{rates.map((rate) => (
							<div
								key={rate.name}
								className="flex items-baseline justify-between gap-6 border-b border-[rgba(222,230,246,0.07)] py-3"
							>
								<dt className="text-[14px] text-[#E8ECF4]">{rate.name}</dt>
								<dd className="m-0 flex flex-wrap items-baseline justify-end gap-x-2 text-right">
									<span
										className={clsx(
											MONO,
											"text-[14px] tabular-nums text-white",
										)}
									>
										{rate.price}
									</span>
									<span className="text-[12.5px] text-[rgba(232,236,244,0.46)]">
										{rate.unit}
									</span>
								</dd>
							</div>
						))}
					</dl>
				</Block>
			</div>

			<Block title="Transactions" description="The 50 most recent.">
				<CreditTransactionTable transactions={transactions} />
			</Block>
		</>
	);
}

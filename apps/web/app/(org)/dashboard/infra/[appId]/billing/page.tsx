import type { Metadata } from "next";
import {
	DELIVERY_DOLLARS_PER_1000_MINUTES,
	SPEECH_DOLLARS_PER_HOUR,
	STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
} from "@/lib/developer-pricing";
import { formatCredits } from "@/lib/infra-usage";
import { CreditTransactionTable } from "../../_components/credit-transaction-table";
import { Panel, Section } from "../../_components/section";
import { getDeveloperTransactions, requireInfraApp } from "../../infra-data";
import { TopUp } from "./top-up";

export const metadata: Metadata = {
	title: "Billing | Cap Infra",
};

const dollars = (value: number) => `$${value.toFixed(2)}`;

const rates = [
	{ name: "Encoding", price: "Free", unit: null },
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
	const transactions = app.creditAccount
		? await getDeveloperTransactions(app.creditAccount.id)
		: [];
	const balance = app.creditAccount?.balanceMicroCredits ?? 0;

	return (
		<>
			<div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
				<Panel className="flex flex-col gap-6 p-5">
					<div className="flex flex-col gap-1">
						<span className="text-sm text-gray-10">Credit balance</span>
						<span className="text-3xl font-medium tabular-nums text-gray-12">
							{formatCredits(balance)}
						</span>
						<span className="text-sm text-gray-10">
							Prepaid credits for {app.name}. Usage is drawn from this balance.
						</span>
					</div>
					{app.creditAccount ? (
						<TopUp appId={app.id} />
					) : (
						<p className="text-sm text-gray-10">
							This app has no credit account, so it cannot be topped up.
						</p>
					)}
				</Panel>

				<Section title="Rates" className="lg:pt-1">
					<Panel>
						<dl>
							{rates.map((rate) => (
								<div
									key={rate.name}
									className="flex gap-4 justify-between items-baseline px-5 py-3 border-b border-gray-3 last:border-0"
								>
									<dt className="text-sm text-gray-12">{rate.name}</dt>
									<dd className="text-sm text-right">
										<span className="tabular-nums text-gray-12">
											{rate.price}
										</span>
										{rate.unit && (
											<span className="block text-xs text-gray-10 sm:inline sm:ml-1.5">
												{rate.unit}
											</span>
										)}
									</dd>
								</div>
							))}
						</dl>
					</Panel>
				</Section>
			</div>

			<Section title="Transactions" description="The 50 most recent.">
				<Panel className="px-5">
					<CreditTransactionTable transactions={transactions} />
				</Panel>
			</Section>
		</>
	);
}

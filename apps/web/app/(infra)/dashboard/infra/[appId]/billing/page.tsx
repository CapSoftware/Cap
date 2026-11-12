import clsx from "clsx";
import type { Metadata } from "next";
import {
	autoTopUpFailureText,
	getAutoTopUpFailure,
} from "@/lib/infra-auto-top-up";
import {
	INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES,
	INFRA_RESOLUTION_TIERS,
	INFRA_SPEECH_DOLLARS_PER_HOUR,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
} from "@/lib/infra-pricing";
import { getInfraBilling } from "@/lib/infra-standing";
import { formatCredits, INFRA_TIER_LABELS } from "@/lib/infra-usage";
import { CreditTransactionTable } from "../../_components/credit-transaction-table";
import { ProCredit } from "../../_components/pro-credit";
import { StandingNotice } from "../../_components/standing-notice";
import { Block, MONO, PageHeader, TD, TH, TR } from "../../_components/ui";
import {
	getDeveloperTransactions,
	getInfraProCredit,
	requireInfraApp,
} from "../../infra-data";
import { AutoTopUp } from "./auto-top-up";
import { TopUp } from "./top-up";

export const metadata: Metadata = {
	title: "Billing | Cap Infra",
};

const dollars = (value: number) => `$${value.toFixed(2)}`;

const tieredRates = [
	{
		name: "Storage",
		unit: "per 1,000 minutes a month",
		rates: INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
	},
	{
		name: "Delivery",
		unit: "per 1,000 minutes watched",
		rates: INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES,
	},
];

const flatRates = [
	{
		name: "Speech to text",
		unit: "per audio hour",
		price: dollars(INFRA_SPEECH_DOLLARS_PER_HOUR),
	},
	{ name: "Encoding and upload", unit: null, price: "Free" },
];

const failureDay = new Intl.DateTimeFormat("en-US", {
	month: "long",
	day: "numeric",
	timeZone: "UTC",
});

const RATE_NAME =
	"py-3 pr-6 text-left text-[13.5px] font-normal leading-[1.45] text-[#E8ECF4]";
const RATE_UNIT = "block text-[12.5px] text-[rgba(232,236,244,0.46)]";
const RATE_PRICE = clsx(
	TD,
	MONO,
	"text-right text-[14px] tabular-nums text-white",
);

export default async function InfraBillingPage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app } = await requireInfraApp(appId);
	const account = app.creditAccount;
	const [transactions, proCredit, billing, failure] = await Promise.all([
		account ? getDeveloperTransactions(account.id) : Promise.resolve([]),
		getInfraProCredit(),
		getInfraBilling(app.id),
		account ? getAutoTopUpFailure(account.id) : Promise.resolve(null),
	]);
	const balance = account?.balanceMicroCredits ?? 0;

	return (
		<>
			<PageHeader
				title="Billing"
				description={`Prepaid credits for ${app.name}. Usage is drawn from this balance.`}
			/>

			<StandingNotice
				appId={app.id}
				standing={billing.standing}
				shortfallMicroCredits={billing.admission.shortfallMicroCredits}
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
						{account ? (
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
					<div className="relative overflow-x-auto">
						<table className="w-full border-collapse">
							<thead>
								<tr className={TR}>
									<th className={TH}>
										<span className="sr-only">Rate</span>
									</th>
									{INFRA_RESOLUTION_TIERS.map((tier) => (
										<th key={tier} className={clsx(TH, "text-right")}>
											{INFRA_TIER_LABELS[tier]}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{tieredRates.map((rate) => (
									<tr key={rate.name} className={TR}>
										<th scope="row" className={RATE_NAME}>
											{rate.name}
											<span className={RATE_UNIT}>{rate.unit}</span>
										</th>
										{INFRA_RESOLUTION_TIERS.map((tier) => (
											<td key={tier} className={RATE_PRICE}>
												{dollars(rate.rates[tier])}
											</td>
										))}
									</tr>
								))}
								{flatRates.map((rate) => (
									<tr key={rate.name} className={TR}>
										<th scope="row" className={RATE_NAME}>
											{rate.name}
											{rate.unit && (
												<span className={RATE_UNIT}>{rate.unit}</span>
											)}
										</th>
										<td
											colSpan={INFRA_RESOLUTION_TIERS.length}
											className={RATE_PRICE}
										>
											{rate.price}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p className="m-0 mt-4 max-w-[520px] text-pretty text-[13px] leading-[1.55] text-[rgba(232,236,244,0.46)]">
						Storage is charged once a day for each video at its resolution.
						Uploading needs a balance that covers seven days of storage.
					</p>
				</Block>
			</div>

			{account && (
				<Block
					title="Auto top-up"
					description="Add credits from a saved card when the balance runs low."
				>
					<AutoTopUp
						appId={app.id}
						hasCard={!!account.stripePaymentMethodId}
						enabled={account.autoTopUpEnabled}
						thresholdMicroCredits={account.autoTopUpThresholdMicroCredits}
						amountCents={account.autoTopUpAmountCents}
						failure={
							failure
								? {
										day: failureDay.format(failure.failedAt),
										reason: autoTopUpFailureText(failure.reason),
									}
								: null
						}
					/>
				</Block>
			)}

			<Block title="Transactions" description="The 50 most recent.">
				<CreditTransactionTable transactions={transactions} />
			</Block>
		</>
	);
}

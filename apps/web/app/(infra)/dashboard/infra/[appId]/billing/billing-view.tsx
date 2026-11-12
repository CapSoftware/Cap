import clsx from "clsx";
import Link from "next/link";
import type { LedgerRow, ledgerPageWindow } from "@/lib/infra-ledger";
import {
	INFRA_RESOLUTION_TIERS,
	INFRA_SPEECH_DOLLARS_PER_HOUR,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
} from "@/lib/infra-pricing";
import { infraAppPath } from "@/lib/infra-routes";
import type { InfraAppStanding } from "@/lib/infra-standing";
import { formatCredits, INFRA_TIER_LABELS } from "@/lib/infra-usage";
import { CreditTransactionTable } from "../../_components/credit-transaction-table";
import { ProCredit } from "../../_components/pro-credit";
import { StandingNotice } from "../../_components/standing-notice";
import {
	Block,
	ButtonLink,
	buttonClass,
	FOCUS,
	MONO,
	PageHeader,
	TD,
	TEXT_LINK,
	TH,
	TR,
} from "../../_components/ui";
import type { InfraProCredit } from "../../infra-data";
import { AutoTopUp } from "./auto-top-up";
import { TopUp } from "./top-up";

const dollars = (value: number) => `$${value.toFixed(2)}`;

const flatRates = [
	{
		name: "Speech to text",
		unit: "per audio hour",
		price: dollars(INFRA_SPEECH_DOLLARS_PER_HOUR),
	},
	{ name: "Encoding and upload", unit: null, price: "Free" },
];

const RATE_NAME =
	"py-3 pr-6 text-left text-[13.5px] font-normal leading-[1.45] text-[#E8ECF4]";
const RATE_UNIT = "block text-[12.5px] text-[rgba(232,236,244,0.46)]";
const RATE_PRICE = clsx(
	TD,
	MONO,
	"text-right text-[14px] tabular-nums text-white",
);

const LEDGER_ANCHOR = "transactions";

export type BillingAccount = {
	balanceMicroCredits: number;
	hasCard: boolean;
	autoTopUpEnabled: boolean;
	autoTopUpThresholdMicroCredits: number;
	autoTopUpAmountCents: number;
};

export function BillingView({
	app,
	account,
	proCredit,
	standing,
	shortfallMicroCredits,
	autoTopUpFailure,
	transactions,
	totalTransactions,
	ledgerPage,
}: {
	app: { id: string; name: string };
	account: BillingAccount | null;
	proCredit: InfraProCredit;
	standing: InfraAppStanding;
	shortfallMicroCredits: number;
	autoTopUpFailure: { day: string; reason: string } | null;
	transactions: LedgerRow[];
	totalTransactions: number;
	ledgerPage: ReturnType<typeof ledgerPageWindow>;
}) {
	const billingPath = infraAppPath(app.id, "billing");
	const ledgerHref = (page: number) =>
		`${billingPath}${page > 1 ? `?page=${page}` : ""}#${LEDGER_ANCHOR}`;

	return (
		<>
			<PageHeader
				title="Billing"
				description={`Prepaid credits for ${app.name}. Usage is drawn from this balance.`}
			/>

			<StandingNotice
				appId={app.id}
				standing={standing}
				shortfallMicroCredits={shortfallMicroCredits}
			/>

			<div className="grid gap-x-16 gap-y-12 border-t border-[rgba(222,230,246,0.08)] pt-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<section className="min-w-0">
					<p className="m-0 text-[13px] text-[rgba(232,236,244,0.5)]">
						Credit balance
					</p>
					<p
						className={clsx(
							MONO,
							"m-0 mt-3 text-[clamp(30px,10vw,44px)] leading-none tracking-[-0.045em] tabular-nums text-white",
						)}
					>
						{formatCredits(account?.balanceMicroCredits ?? 0)}
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
								<tr className={TR}>
									<th scope="row" className={RATE_NAME}>
										Storage
										<span className={RATE_UNIT}>per 1,000 minutes a month</span>
									</th>
									{INFRA_RESOLUTION_TIERS.map((tier) => (
										<td key={tier} className={RATE_PRICE}>
											{dollars(
												INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH[tier],
											)}
										</td>
									))}
								</tr>
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
						Uploading needs a balance that covers seven days of storage.{" "}
						<Link
							href="/docs/api/billing"
							className={clsx(TEXT_LINK, FOCUS, "rounded-[4px]")}
						>
							How billing works
						</Link>
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
						hasCard={account.hasCard}
						enabled={account.autoTopUpEnabled}
						thresholdMicroCredits={account.autoTopUpThresholdMicroCredits}
						amountCents={account.autoTopUpAmountCents}
						failure={autoTopUpFailure}
					/>
				</Block>
			)}

			<div id={LEDGER_ANCHOR} className="scroll-mt-24">
				<Block
					title="Transactions"
					description="Every credit and charge, newest first. Times are in UTC."
					action={
						totalTransactions > 0 && (
							<a
								href={`/api/developer/credits/transactions?appId=${encodeURIComponent(app.id)}`}
								download
								className={buttonClass("ghost", "sm")}
							>
								Export CSV
							</a>
						)
					}
				>
					<CreditTransactionTable transactions={transactions} />
					{ledgerPage.pages > 1 && (
						<nav
							aria-label="Transaction pages"
							className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pt-4"
						>
							<p className="m-0 text-[13px] tabular-nums text-[rgba(232,236,244,0.5)]">
								{ledgerPage.from.toLocaleString("en-US")} to{" "}
								{ledgerPage.to.toLocaleString("en-US")} of{" "}
								{totalTransactions.toLocaleString("en-US")}
							</p>
							<div className="flex gap-2">
								{ledgerPage.page > 1 && (
									<ButtonLink
										variant="ghost"
										size="sm"
										href={ledgerHref(ledgerPage.page - 1)}
									>
										Newer
									</ButtonLink>
								)}
								{ledgerPage.page < ledgerPage.pages && (
									<ButtonLink
										variant="ghost"
										size="sm"
										href={ledgerHref(ledgerPage.page + 1)}
									>
										Older
									</ButtonLink>
								)}
							</div>
						</nav>
					)}
				</Block>
			</div>
		</>
	);
}

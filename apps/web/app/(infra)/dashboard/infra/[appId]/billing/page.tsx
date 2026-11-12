import type { Metadata } from "next";
import {
	autoTopUpFailureText,
	getAutoTopUpFailure,
} from "@/lib/infra-auto-top-up";
import { LEDGER_PAGE_SIZE, ledgerPageWindow } from "@/lib/infra-ledger";
import { countAppLedger, listAppLedger } from "@/lib/infra-ledger-store";
import { getInfraBilling } from "@/lib/infra-standing";
import { getInfraProCredit, requireInfraApp } from "../../infra-data";
import { BillingView } from "./billing-view";

export const metadata: Metadata = {
	title: "Billing | Cap Infra",
};

const failureDay = new Intl.DateTimeFormat("en-US", {
	month: "long",
	day: "numeric",
	timeZone: "UTC",
});

export default async function InfraBillingPage({
	params,
	searchParams,
}: {
	params: Promise<{ appId: string }>;
	searchParams: Promise<{ page?: string | string[] }>;
}) {
	const [{ appId }, query] = await Promise.all([params, searchParams]);
	const { app } = await requireInfraApp(appId);
	const account = app.creditAccount;
	const [total, proCredit, billing, failure] = await Promise.all([
		account ? countAppLedger(app.id) : Promise.resolve(0),
		getInfraProCredit(),
		getInfraBilling(app.id),
		account ? getAutoTopUpFailure(account.id) : Promise.resolve(null),
	]);
	const ledgerPage = ledgerPageWindow(
		Array.isArray(query.page) ? query.page[0] : query.page,
		total,
	);
	const transactions =
		total > 0
			? (
					await listAppLedger(app.id, {
						limit: LEDGER_PAGE_SIZE,
						offset: ledgerPage.offset,
					})
				).rows
			: [];

	return (
		<BillingView
			app={{ id: app.id, name: app.name }}
			account={
				account
					? {
							balanceMicroCredits: account.balanceMicroCredits,
							hasCard: !!account.stripePaymentMethodId,
							autoTopUpEnabled: account.autoTopUpEnabled,
							autoTopUpThresholdMicroCredits:
								account.autoTopUpThresholdMicroCredits,
							autoTopUpAmountCents: account.autoTopUpAmountCents,
						}
					: null
			}
			proCredit={proCredit}
			standing={billing.standing}
			shortfallMicroCredits={billing.admission.shortfallMicroCredits}
			autoTopUpFailure={
				failure
					? {
							day: failureDay.format(failure.failedAt),
							reason: autoTopUpFailureText(failure.reason),
						}
					: null
			}
			transactions={transactions}
			totalTransactions={total}
			ledgerPage={ledgerPage}
		/>
	);
}

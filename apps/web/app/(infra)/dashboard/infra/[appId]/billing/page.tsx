import type { Metadata } from "next";
import {
	autoTopUpFailureText,
	getAutoTopUpFailure,
} from "@/lib/infra-auto-top-up";
import { deliveryBillingStart } from "@/lib/infra-delivery-flag";
import { LEDGER_PAGE_SIZE } from "@/lib/infra-ledger";
import {
	type LedgerPage,
	listAppLedgerPage,
	parseLedgerCursor,
} from "@/lib/infra-ledger-store";
import { getInfraBilling } from "@/lib/infra-standing";
import { getInfraProCredit, requireInfraApp } from "../../infra-data";
import { BillingView } from "./billing-view";

export const metadata: Metadata = {
	title: "Billing | Cap Infra",
};

const EMPTY_LEDGER: LedgerPage = { rows: [], newer: null, older: null };

const first = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

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
	searchParams: Promise<{
		before?: string | string[];
		after?: string | string[];
	}>;
}) {
	const [{ appId }, query] = await Promise.all([params, searchParams]);
	const { app } = await requireInfraApp(appId);
	const account = app.creditAccount;
	const [ledger, proCredit, billing, failure] = await Promise.all([
		account
			? listAppLedgerPage(app.id, {
					limit: LEDGER_PAGE_SIZE,
					before: parseLedgerCursor(first(query.before)),
					after: parseLedgerCursor(first(query.after)),
				})
			: Promise.resolve(EMPTY_LEDGER),
		getInfraProCredit(),
		getInfraBilling(app.id),
		account ? getAutoTopUpFailure(account.id) : Promise.resolve(null),
	]);

	return (
		<BillingView
			deliveryBilledFrom={deliveryBillingStart()}
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
			transactions={ledger.rows}
			ledgerPage={{ newer: ledger.newer, older: ledger.older }}
		/>
	);
}

import type { InfraStandingState } from "@/lib/infra-standing";
import { formatCredits, formatNeed } from "@/lib/infra-usage";

export function lowBalanceText({
	hasAccount,
	standing,
	monthlyStorageMicroCredits,
	balanceMicroCredits,
	requiredMicroCredits,
	shortfallMicroCredits,
}: {
	hasAccount: boolean;
	standing: InfraStandingState;
	monthlyStorageMicroCredits: number;
	balanceMicroCredits: number;
	requiredMicroCredits: number;
	shortfallMicroCredits: number;
}) {
	if (!hasAccount || standing !== "active") return null;
	if (monthlyStorageMicroCredits <= 0 || shortfallMicroCredits <= 0) {
		return null;
	}
	return `Credit is low. Uploading needs at least ${formatNeed(requiredMicroCredits)} and this app has ${formatCredits(balanceMicroCredits)}.`;
}

export function firstCreditOffersAddCredits({
	balanceMicroCredits,
	proCreditStatus,
}: {
	balanceMicroCredits: number;
	proCreditStatus: string;
}) {
	return balanceMicroCredits <= 0 && proCreditStatus !== "available";
}

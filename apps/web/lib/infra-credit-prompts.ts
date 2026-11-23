import { MICRO_CREDITS_PER_DOLLAR } from "@/lib/developer-pricing";
import type { InfraStandingState } from "@/lib/infra-standing";
import { formatCredits, formatNeed } from "@/lib/infra-usage";

export const LOW_BALANCE_FLOOR = MICRO_CREDITS_PER_DOLLAR;

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
	if (monthlyStorageMicroCredits > 0) {
		if (shortfallMicroCredits <= 0) return null;
		return `Credit is low. Uploading needs at least ${formatNeed(requiredMicroCredits)} and this app has ${formatCredits(balanceMicroCredits)}.`;
	}
	if (balanceMicroCredits <= 0 || balanceMicroCredits >= LOW_BALANCE_FLOOR) {
		return null;
	}
	return `Credit is low. This app has ${formatCredits(balanceMicroCredits)}, under ${formatCredits(LOW_BALANCE_FLOOR)}.`;
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

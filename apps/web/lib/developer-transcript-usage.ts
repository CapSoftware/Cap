import { getTranscriptionUsageSince } from "@/lib/developer-transcript-store";
import { readBalanceAndHolds } from "@/lib/infra-balance";
import { utcMonthStart } from "@/lib/infra-usage";

export async function getSpeechUsage(appId: string, now: Date = new Date()) {
	const periodStart = utcMonthStart(now);
	const [month, credit] = await Promise.all([
		getTranscriptionUsageSince(appId, periodStart),
		readBalanceAndHolds(appId),
	]);
	const balanceMicroCredits = credit?.balanceMicroCredits ?? 0;
	const heldMicroCredits = credit?.heldMicroCredits ?? 0;
	return {
		balanceMicroCredits,
		availableMicroCredits: balanceMicroCredits - heldMicroCredits,
		heldMicroCredits,
		speech: {
			periodStart: periodStart.toISOString(),
			seconds: Math.round(month.audioSeconds * 1000) / 1000,
			microCredits: month.chargedMicroCredits,
			transcripts: month.transcripts,
		},
	};
}

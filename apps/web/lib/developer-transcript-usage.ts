import { db } from "@cap/database";
import { getTranscriptionUsageSince } from "@/lib/developer-transcript-store";
import {
	availableBalance,
	heldTranscriptMicroCredits,
} from "@/lib/infra-balance";
import { utcMonthStart } from "@/lib/infra-usage";

export async function getSpeechUsage(appId: string, now: Date = new Date()) {
	const periodStart = utcMonthStart(now);
	const [month, heldMicroCredits, available] = await Promise.all([
		getTranscriptionUsageSince(appId, periodStart),
		heldTranscriptMicroCredits(db(), appId),
		availableBalance(appId),
	]);
	return {
		availableMicroCredits: available ?? 0,
		heldMicroCredits,
		speech: {
			periodStart: periodStart.toISOString(),
			seconds: Math.round(month.audioSeconds * 1000) / 1000,
			microCredits: month.chargedMicroCredits,
			transcripts: month.transcripts,
		},
	};
}

import { listAudioTranscripts } from "@/actions/developers/transcripts";
import { SPEECH_DOLLARS_PER_HOUR } from "@/lib/developer-pricing";
import { TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS } from "@/lib/developer-transcripts";
import { formatCredits, formatNeed } from "@/lib/infra-usage";
import { infraPageMetadata, requireInfraApp } from "../../infra-data";
import { AudioClient } from "./audio-client";

export const generateMetadata = infraPageMetadata("Audio");

export default async function InfraAudioPage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app } = await requireInfraApp(appId);
	const result = await listAudioTranscripts(app.id);
	const balance = app.creditAccount?.balanceMicroCredits ?? 0;

	return (
		<AudioClient
			appId={app.id}
			initialTranscripts={result.ok ? result.transcripts : []}
			initialHasMore={result.ok ? result.hasMore : false}
			available={result.ok}
			canTranscribe={balance >= TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS}
			creditNeeded={formatNeed(TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS)}
			creditBalance={formatCredits(balance)}
			pricePerHour={`$${SPEECH_DOLLARS_PER_HOUR.toFixed(2)}`}
		/>
	);
}

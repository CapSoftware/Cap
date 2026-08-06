import { Video } from "@cap/web-domain";

export function isAgentUploadAllowedForPlan({
	durationSeconds,
	isPro,
}: {
	durationSeconds: number | undefined;
	isPro: boolean;
}) {
	return (
		isPro ||
		(durationSeconds !== undefined &&
			durationSeconds >= 0 &&
			durationSeconds <= Video.FREE_PLAN_MAX_RECORDING_SECONDS)
	);
}

export function isAgentUploadAllowedForMeasuredDuration({
	durationSeconds,
	isPro,
}: {
	durationSeconds: number;
	isPro: boolean;
}) {
	return (
		isPro ||
		(Number.isFinite(durationSeconds) &&
			durationSeconds > 0 &&
			durationSeconds <= Video.FREE_PLAN_MAX_RECORDING_SECONDS)
	);
}

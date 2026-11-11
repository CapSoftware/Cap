export const MICRO_CREDITS_PER_DOLLAR = 100_000;

const STORAGE_MICRO_CREDITS_PER_MINUTE_PER_MONTH = 80;
const STORAGE_BILLING_DAYS_PER_MONTH = 30;

export const STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH =
	(STORAGE_MICRO_CREDITS_PER_MINUTE_PER_MONTH * 1000) /
	MICRO_CREDITS_PER_DOLLAR;
export const UPLOAD_MICRO_CREDITS_PER_MINUTE = 5_000;
export const UPLOAD_DOLLARS_PER_MINUTE =
	UPLOAD_MICRO_CREDITS_PER_MINUTE / MICRO_CREDITS_PER_DOLLAR;
export const DELIVERY_DOLLARS_PER_1000_MINUTES = 0.5;
export const SPEECH_DOLLARS_PER_HOUR = 0.1;
export const SPEECH_MICRO_CREDITS_PER_HOUR = Math.round(
	SPEECH_DOLLARS_PER_HOUR * MICRO_CREDITS_PER_DOLLAR,
);

export function dailyStorageMicroCredits(totalMinutes: number) {
	return Math.floor(
		(totalMinutes * STORAGE_MICRO_CREDITS_PER_MINUTE_PER_MONTH) /
			STORAGE_BILLING_DAYS_PER_MONTH,
	);
}

export function transcriptionBilledSeconds(durationSeconds: number) {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
	return Math.max(1, Math.round(durationSeconds));
}

export function transcriptionMicroCredits(durationSeconds: number) {
	const billedSeconds = transcriptionBilledSeconds(durationSeconds);
	if (billedSeconds === 0) return 0;
	return Math.max(
		1,
		Math.floor((billedSeconds * SPEECH_MICRO_CREDITS_PER_HOUR) / 3600),
	);
}

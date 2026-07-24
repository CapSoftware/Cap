export const teleprompterDefaults = {
	fontSize: 30,
	wordsPerMinute: 150,
} as const;

export const teleprompterLimits = {
	fontSize: { minimum: 24, maximum: 44, step: 2 },
	wordsPerMinute: { minimum: 60, maximum: 350, step: 10 },
} as const;

export const clamp = (value: number, minimum: number, maximum: number) =>
	Math.min(maximum, Math.max(minimum, value));

export const countWords = (text: string) =>
	text.trim() ? text.trim().split(/\s+/u).length : 0;

export const calculatePlaybackDurationMs = (
	script: string,
	wordsPerMinute: number,
) => {
	const wordCount = countWords(script);
	if (wordCount === 0) return 0;
	return Math.max(1000, (wordCount / Math.max(1, wordsPerMinute)) * 60_000);
};

export const calculateRemainingPlaybackDurationMs = (
	totalDurationMs: number,
	progress: number,
) => Math.max(0, totalDurationMs * (1 - clamp(progress, 0, 1)));

export const formatRecordingDuration = (elapsedSeconds: number) => {
	const safeSeconds = Math.max(0, Math.floor(elapsedSeconds));
	const hours = Math.floor(safeSeconds / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	const seconds = safeSeconds % 60;
	const minuteText = hours > 0 ? String(minutes).padStart(2, "0") : minutes;
	const time = `${minuteText}:${String(seconds).padStart(2, "0")}`;
	return hours > 0 ? `${hours}:${time}` : time;
};

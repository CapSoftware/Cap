const WORDS_PER_MINUTE = 200;

export function calculateReadingTime(content: string): number {
	const words = content.trim().split(/\s+/).length;
	const time = Math.ceil(words / WORDS_PER_MINUTE);
	return Math.max(1, time);
}

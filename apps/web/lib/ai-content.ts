export const MAX_SUMMARY_LENGTH = 50000;
export const MAX_CHAPTERS = 200;
export const MAX_CHAPTER_TITLE_LENGTH = 300;

export type AiContent = {
	summary: string;
	chapters: { title: string; start: number }[];
};

export function validateAiContent(
	content: AiContent,
	duration?: number | null,
) {
	if (content.summary.length > MAX_SUMMARY_LENGTH) {
		return `Keep the summary under ${MAX_SUMMARY_LENGTH.toLocaleString()} characters.`;
	}
	if (content.chapters.length > MAX_CHAPTERS) {
		return `Use no more than ${MAX_CHAPTERS} chapters.`;
	}
	for (const [index, chapter] of content.chapters.entries()) {
		const label = `Chapter ${index + 1}`;
		if (!chapter.title.trim()) return `${label} needs a title.`;
		if (chapter.title.length > MAX_CHAPTER_TITLE_LENGTH) {
			return `${label}'s title must be ${MAX_CHAPTER_TITLE_LENGTH} characters or fewer.`;
		}
		if (!Number.isFinite(chapter.start) || chapter.start < 0) {
			return `${label} needs a valid timestamp (MM:SS or HH:MM:SS).`;
		}
		if (duration != null && duration > 0 && chapter.start >= duration) {
			return `${label} must start before the video ends.`;
		}
		const previous = content.chapters[index - 1];
		if (previous && chapter.start <= previous.start) {
			return "Chapter timestamps must be unique and in increasing order.";
		}
	}
	return null;
}

export function parseChapterTime(value: string) {
	const match = /^(?:(\d+):)?(\d+):([0-5]\d(?:\.\d{1,3})?)$/.exec(value.trim());
	if (!match) return Number.NaN;
	const hours = match[1] ? Number(match[1]) : 0;
	const minutes = Number(match[2]);
	if (match[1] && minutes > 59) return Number.NaN;
	return hours * 3600 + minutes * 60 + Number(match[3]);
}

export function formatChapterTime(time: number) {
	const milliseconds = Math.round(time * 1000);
	const hours = Math.floor(milliseconds / 3600000);
	const minutes = Math.floor((milliseconds % 3600000) / 60000);
	const seconds = Math.floor((milliseconds % 60000) / 1000);
	const fraction = milliseconds % 1000;
	return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${fraction ? `.${String(fraction).padStart(3, "0").replace(/0+$/, "")}` : ""}`;
}

export function chaptersEqual(
	left: AiContent["chapters"],
	right: AiContent["chapters"],
) {
	return (
		left.length === right.length &&
		left.every(
			(chapter, index) =>
				chapter.title === right[index]?.title &&
				chapter.start === right[index]?.start,
		)
	);
}

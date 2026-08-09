export type TranscriptTextEntry = {
	text: string;
	startTime: number;
	endTime: number;
};

const PARAGRAPH_GAP_SECONDS = 1.75;
const SOFT_PARAGRAPH_CHAR_LIMIT = 500;
const HARD_PARAGRAPH_CHAR_LIMIT = 1200;

function endsSentence(text: string) {
	return /[.!?]["')\]]?$/.test(text);
}

/**
 * Joins caption-sized fragments into flowing paragraphs for use in documents.
 * Paragraphs break at sentence boundaries when the speaker pauses, or when a
 * paragraph grows past a comfortable reading length; a hard limit guards
 * against transcripts with no sentence punctuation at all.
 */
export function formatTranscriptAsParagraphs(
	entries: readonly TranscriptTextEntry[],
): string {
	const paragraphs: string[] = [];
	let current = "";

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry) continue;
		const text = entry.text.trim();
		if (!text) continue;

		current = current ? `${current} ${text}` : text;

		const next = entries[index + 1];
		if (!next) break;

		if (current.length >= HARD_PARAGRAPH_CHAR_LIMIT) {
			paragraphs.push(current);
			current = "";
			continue;
		}

		if (!endsSentence(text)) continue;

		const gapSeconds =
			entry.endTime > entry.startTime ? next.startTime - entry.endTime : 0;
		if (
			gapSeconds >= PARAGRAPH_GAP_SECONDS ||
			current.length >= SOFT_PARAGRAPH_CHAR_LIMIT
		) {
			paragraphs.push(current);
			current = "";
		}
	}

	if (current) paragraphs.push(current);
	return paragraphs.join("\n\n");
}

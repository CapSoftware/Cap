import type { TranscriptEntry } from "@/lib/transcript-vtt";

function endsSentence(text: string): boolean {
	const ending = text.trim().replace(/["'”’»）)\]}]+$/u, "");
	if (/(?:\.{2,}|…)$/.test(ending)) return false;
	if (
		/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)|\b[A-ZА-Я])\.$/iu.test(ending)
	)
		return false;
	return /[.!?。！？]$/u.test(ending);
}

export function groupTranscriptSentences(
	entries: readonly TranscriptEntry[],
): TranscriptEntry[] {
	const sentences: TranscriptEntry[] = [];
	let current: TranscriptEntry | undefined;
	let previous: TranscriptEntry | undefined;

	for (const entry of entries) {
		if (!entry.text.trim()) continue;
		if (
			current &&
			previous &&
			((previous.speaker ?? null) !== (entry.speaker ?? null) ||
				endsSentence(previous.text) ||
				entry.startTime - previous.endTime >= 5 ||
				entry.startTime < previous.endTime ||
				current.text.length + entry.text.length + 1 > 800 ||
				entry.endTime - current.startTime > 45)
		) {
			sentences.push(current);
			current = undefined;
		}
		current = current
			? {
					...current,
					text: `${current.text} ${entry.text.trim()}`,
					endTime: entry.endTime,
				}
			: { ...entry, text: entry.text.trim() };
		previous = entry;
	}
	if (current) sentences.push(current);
	return sentences;
}

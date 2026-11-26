import {
	escapeVttText,
	isTranscriptSpeakerId,
} from "@/lib/transcript-speakers";

export interface AssemblyAIWord {
	text: string;
	start: number;
	end: number;
	confidence?: number;
	speaker?: string | null;
}

export interface AssemblyAIResult {
	words?: readonly AssemblyAIWord[] | null;
}

export function formatTimestamp(milliseconds: number): string {
	const totalMilliseconds = Math.max(0, Math.round(milliseconds));
	const hours = Math.floor(totalMilliseconds / 3_600_000);
	const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
	const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
	const millis = totalMilliseconds % 1_000;

	return `${hours.toString().padStart(2, "0")}:${minutes
		.toString()
		.padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${millis
		.toString()
		.padStart(3, "0")}`;
}

export function formatToWebVTT(result: AssemblyAIResult): string {
	let output = "WEBVTT\n\n";
	let captionIndex = 1;
	const words = result.words;

	if (!words || words.length === 0) {
		return output;
	}

	let group: string[] = [];
	let start = formatTimestamp(words[0]?.start ?? 0);
	let wordCount = 0;
	let groupEnd = 0;
	const speakerId = (word: AssemblyAIWord | undefined) =>
		isTranscriptSpeakerId(word?.speaker) ? word.speaker : null;
	let speaker = speakerId(words[0]);
	const captionText = () => {
		const text = escapeVttText(group.join(" "));
		return speaker ? `<v ${speaker}>${text}</v>` : text;
	};

	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (!word) continue;

		group.push(word.text);
		groupEnd = Math.max(groupEnd, word.end);
		wordCount++;

		const nextWord = words[i + 1];
		const shouldBreak =
			(nextWord && speakerId(nextWord) !== speaker) ||
			/[,.!?;:]$/.test(word.text) ||
			(nextWord && nextWord.start - word.end > 500) ||
			wordCount === 8;

		if (shouldBreak) {
			const end = formatTimestamp(groupEnd);
			output += `${captionIndex}\n${start} --> ${end}\n${captionText()}\n\n`;
			captionIndex++;
			group = [];
			start = nextWord ? formatTimestamp(nextWord.start) : start;
			wordCount = 0;
			groupEnd = 0;
			speaker = speakerId(nextWord);
		}
	}

	if (group.length > 0) {
		const lastWord = words[words.length - 1];
		if (lastWord) {
			const end = formatTimestamp(groupEnd);
			output += `${captionIndex}\n${start} --> ${end}\n${captionText()}\n\n`;
		}
	}

	return output;
}

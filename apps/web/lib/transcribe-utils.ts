export interface DeepgramWord {
	word: string;
	punctuated_word: string;
	start: number;
	end: number;
	confidence?: number;
}

export interface DeepgramUtterance {
	words: DeepgramWord[];
	transcript?: string;
	start?: number;
	end?: number;
	confidence?: number;
}

export interface DeepgramResult {
	results: {
		utterances: DeepgramUtterance[] | null;
	};
}

export function formatTimestamp(seconds: number): string {
	const date = new Date(seconds * 1000);
	const hours = date.getUTCHours().toString().padStart(2, "0");
	const minutes = date.getUTCMinutes().toString().padStart(2, "0");
	const secs = date.getUTCSeconds().toString().padStart(2, "0");
	const millis = (date.getUTCMilliseconds() / 1000).toFixed(3).slice(2, 5);

	return `${hours}:${minutes}:${secs}.${millis}`;
}

export function formatToWebVTT(result: DeepgramResult): string {
	let output = "WEBVTT\n\n";
	let captionIndex = 1;

	if (!result.results.utterances || result.results.utterances.length === 0) {
		return output;
	}

	for (const utterance of result.results.utterances) {
		const words = utterance.words;
		if (!words || words.length === 0) continue;

		let group: string[] = [];
		let start = formatTimestamp(words[0]?.start ?? 0);
		let wordCount = 0;

		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			if (!word) continue;

			group.push(word.punctuated_word);
			wordCount++;

			const nextWord = words[i + 1];
			const shouldBreak =
				word.punctuated_word.endsWith(",") ||
				word.punctuated_word.endsWith(".") ||
				(nextWord && nextWord.start - word.end > 0.5) ||
				wordCount === 8;

			if (shouldBreak) {
				const end = formatTimestamp(word.end);
				const groupText = group.join(" ");

				output += `${captionIndex}\n${start} --> ${end}\n${groupText}\n\n`;
				captionIndex++;

				group = [];
				start = nextWord ? formatTimestamp(nextWord.start) : start;
				wordCount = 0;
			}
		}

		if (group.length > 0) {
			const lastWord = words[words.length - 1];
			if (lastWord) {
				const end = formatTimestamp(lastWord.end);
				const groupText = group.join(" ");
				output += `${captionIndex}\n${start} --> ${end}\n${groupText}\n\n`;
				captionIndex++;
			}
		}
	}

	return output;
}

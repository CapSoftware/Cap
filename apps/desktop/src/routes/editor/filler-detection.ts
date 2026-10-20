import { MAX_CAPTION_WORD_DURATION } from "./captions";

const FILLER_WORDS = new Set([
	"uh",
	"um",
	"uhm",
	"ah",
	"er",
	"erm",
	"hm",
	"mhm",
]);

const ENGLISH_MARKERS = new Set([
	"the",
	"and",
	"you",
	"that",
	"it",
	"this",
	"with",
	"what",
	"have",
	"are",
	"think",
	"know",
	"just",
	"yeah",
	"yes",
	"right",
	"really",
	"because",
	"there",
]);

// "err" is a verb and an all-caps "ER" an acronym, yet both collapse to the
// filler "er". Drawn-out forms like "errr" or "UMMM" still count.
const NOT_FILLERS = new Set(["err"]);

export function isFillerWord(text: string): boolean {
	const letters = text.replace(/[^a-z]/gi, "");
	if (
		letters.length > 1 &&
		letters === letters.toUpperCase() &&
		!/(.)\1/.test(letters)
	)
		return false;
	const lower = letters.toLowerCase();
	return (
		!NOT_FILLERS.has(lower) && FILLER_WORDS.has(lower.replace(/(.)\1+/g, "$1"))
	);
}

// "um" is a Portuguese article and a German preposition, and "er" is German
// for "he" and Dutch for "there". Captions don't record their language, so
// the English fillers only count in transcripts that read as English.
export function readsAsEnglish(texts: readonly string[]): boolean {
	let markers = 0;
	for (const text of texts) {
		if (ENGLISH_MARKERS.has(text.toLowerCase().replace(/[^a-z]/g, "")))
			markers++;
	}
	return markers > 0 && markers >= texts.length * 0.05;
}

// Transcription engines often stretch a word's end across the silence that
// follows it. Capping a word at the caption track's longest spoken word lets
// that silence count as a pause without ever treating real speech as silence.
export function spokenWordEnd(word: { start: number; end: number }): number {
	return Math.min(word.end, word.start + MAX_CAPTION_WORD_DURATION);
}

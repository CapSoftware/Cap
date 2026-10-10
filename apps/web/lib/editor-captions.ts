import type { EditTranscript } from "./edit-transcript";
import { isFillerWord } from "./edit-transcript";

export type EditorCaptionWord = {
	text: string;
	start: number;
	end: number;
};

export type EditorCaptionSegment = {
	id: string;
	start: number;
	end: number;
	text: string;
	words: EditorCaptionWord[];
};

export type EditorCaptionData = {
	segments: EditorCaptionSegment[];
	settings: null;
};

const TARGET_WORDS = 6;
const MAX_WORDS = 8;
const MIN_FINAL_WORDS = 3;
const MAX_WORD_SECONDS = 2.5;
const encoder = new TextEncoder();
const WEAK_BOUNDARY_WORDS = new Set([
	"an",
	"as",
	"at",
	"be",
	"by",
	"do",
	"he",
	"if",
	"in",
	"is",
	"it",
	"me",
	"my",
	"of",
	"on",
	"or",
	"so",
	"to",
	"up",
	"we",
]);
const ATTACHING_PUNCTUATION = new Set([
	",",
	".",
	"!",
	"?",
	";",
	":",
	"%",
	")",
	"]",
	"}",
	"'",
	"’",
	"、",
	"。",
	"！",
	"？",
	"；",
	"：",
	"，",
]);

function attachesToPrevious(text: string) {
	return ATTACHING_PUNCTUATION.has(text.charAt(0));
}

function isWeakBoundary(word: EditorCaptionWord) {
	const normalized = word.text
		.trim()
		.replace(/[^\p{L}\p{N}]/gu, "")
		.toLocaleLowerCase();
	return (
		encoder.encode(normalized).byteLength <= 1 ||
		WEAK_BOUNDARY_WORDS.has(normalized)
	);
}

function captionText(words: readonly EditorCaptionWord[]) {
	let text = "";
	for (const word of words) {
		if (text && !attachesToPrevious(word.text)) text += " ";
		text += word.text;
	}
	return text;
}

export function editTranscriptToEditorCaptions(
	transcript: EditTranscript,
): EditorCaptionData {
	const words: EditorCaptionWord[] = [];
	for (const source of transcript.words) {
		const text = source.text.trim();
		if (!text || isFillerWord(text)) continue;
		const start = source.startMs / 1000;
		const end = source.endMs / 1000;
		if (end <= start) continue;
		const previous = words[words.length - 1];
		if (attachesToPrevious(text) && previous) {
			previous.text += text;
			previous.end = end;
		} else {
			words.push({ text, start, end });
		}
	}
	for (const word of words) {
		word.end = Math.min(word.end, word.start + MAX_WORD_SECONDS);
	}

	const segments: EditorCaptionSegment[] = [];
	let index = 0;
	while (index < words.length) {
		const remaining = words.length - index;
		let end =
			remaining <= TARGET_WORDS
				? words.length
				: Math.min(index + TARGET_WORDS, words.length);
		while (end < words.length && end - index < MAX_WORDS) {
			const boundary = words[end - 1];
			if (!boundary || !isWeakBoundary(boundary)) break;
			end++;
		}
		const finalCount = words.length - end;
		const next = words[end];
		if (
			finalCount > 0 &&
			finalCount < MIN_FINAL_WORDS &&
			next &&
			isWeakBoundary(next)
		) {
			end = words.length;
		}
		const chunk = words.slice(index, end);
		const first = chunk[0];
		const last = chunk[chunk.length - 1];
		if (!first || !last) break;
		segments.push({
			id: `segment-${segments.length}`,
			start: first.start,
			end: last.end,
			text: captionText(chunk),
			words: chunk,
		});
		index = end;
	}
	return { segments, settings: null };
}

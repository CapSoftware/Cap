import type { EditorProjectConfiguration } from "./context";
import { hideCaptionSpeech, removeCaptionWords } from "./transcript-cuts";

export interface FlatWord {
	text: string;
	start: number;
	end: number;
	segmentIndex: number;
	wordIndex: number;
}

export function deleteTranscriptWords(
	project: Pick<EditorProjectConfiguration, "captions">,
	wordsToDelete: FlatWord[],
) {
	const captions = project.captions;
	if (!captions || wordsToDelete.length === 0) return "empty";
	removeCaptionWords(captions, wordsToDelete);
	hideCaptionSpeech(captions, wordsToDelete);
	return "deleted";
}

export function transcriptSeekPosition(
	time: number,
	position: number,
	zoom: number,
) {
	return time >= position && time <= position + zoom
		? position
		: Math.max(0, time - zoom / 2);
}

export type TranscriptKeyAction =
	| "edit"
	| "delete"
	| "cut"
	| "previous"
	| "next";

export function transcriptKeyAction(
	event: Pick<
		KeyboardEvent,
		"key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey"
	>,
	selectedCount: number,
	fromContainer: boolean,
): TranscriptKeyAction | null {
	if (selectedCount === 0) return null;
	switch (event.key) {
		case "Enter":
			return fromContainer && selectedCount === 1 ? "edit" : null;
		case "Backspace":
		case "Delete":
			return event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
				? "cut"
				: "delete";
		case "ArrowLeft":
			return "previous";
		case "ArrowRight":
			return "next";
		default:
			return null;
	}
}

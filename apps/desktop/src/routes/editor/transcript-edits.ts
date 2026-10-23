import type { SegmentRecordings } from "~/utils/tauri";
import {
	getCaptionTextFromWords,
	type MappedTimeRange,
	mapSourceRangeToEdited,
} from "./captions";
import {
	clipCutPreservesTransitionGeometry,
	rangeIntersectsClipTransition,
} from "./clip-transitions";
import type { EditorProjectConfiguration } from "./context";
import { rippleDeleteAllTracks } from "./timeline-utils";

export interface FlatWord {
	text: string;
	start: number;
	end: number;
	segmentIndex: number;
	wordIndex: number;
}

export function deleteTranscriptWords(
	project: Pick<EditorProjectConfiguration, "captions" | "timeline">,
	wordsToDelete: FlatWord[],
	recordingSegments: SegmentRecordings[],
	mode: "captions" | "video" = "captions",
) {
	const captions = project.captions;
	if (!captions || wordsToDelete.length === 0) return "empty";
	const sorted = [...wordsToDelete].sort((a, b) => {
		if (a.segmentIndex !== b.segmentIndex)
			return b.segmentIndex - a.segmentIndex;
		return b.wordIndex - a.wordIndex;
	});

	const sourceRanges = (mode === "video" ? wordsToDelete : [])
		.map((w) => ({ start: w.start, end: w.end }))
		.sort((a, b) => a.start - b.start);

	const mergedSourceRanges: { start: number; end: number }[] = [];
	for (const range of sourceRanges) {
		const last = mergedSourceRanges[mergedSourceRanges.length - 1];
		if (last && range.start <= last.end) {
			last.end = Math.max(last.end, range.end);
		} else {
			mergedSourceRanges.push({ ...range });
		}
	}

	const outputRanges = mergedSourceRanges
		.flatMap((range) =>
			mapSourceRangeToEdited(
				range.start,
				range.end,
				project.timeline?.segments ?? [],
				recordingSegments,
				project.timeline?.transitions ?? [],
			),
		)
		.sort((a, b) => a.start - b.start || a.segmentIndex - b.segmentIndex);

	const mergedOutputRanges: MappedTimeRange[] = [];
	for (const range of outputRanges) {
		const last = mergedOutputRanges[mergedOutputRanges.length - 1];
		if (
			last &&
			last.segmentIndex === range.segmentIndex &&
			range.start <= last.end + 0.0001
		) {
			last.end = Math.max(last.end, range.end);
		} else {
			mergedOutputRanges.push({ ...range });
		}
	}

	const timeline = project.timeline;
	if (
		timeline &&
		mergedOutputRanges.some(
			(range) =>
				rangeIntersectsClipTransition(
					timeline.segments,
					timeline.transitions ?? [],
					range.start,
					range.end,
				) ||
				!clipCutPreservesTransitionGeometry(
					timeline.segments,
					timeline.transitions ?? [],
					range.segmentIndex,
					range.start,
					range.end,
				),
		)
	) {
		return "transition";
	}

	for (const word of sorted) {
		const seg = captions.segments[word.segmentIndex];
		if (!seg?.words) continue;
		if (word.wordIndex >= 0 && word.wordIndex < seg.words.length) {
			seg.words.splice(word.wordIndex, 1);
		}
	}

	for (const i of [...new Set(sorted.map((word) => word.segmentIndex))]) {
		const seg = captions.segments[i];
		if (!seg) continue;
		if (!seg.words || seg.words.length === 0) {
			captions.segments.splice(i, 1);
		} else {
			seg.text = getCaptionTextFromWords(seg.words);
			seg.start = seg.words[0].start;
			seg.end = seg.words[seg.words.length - 1].end;
		}
	}

	if (project.timeline) {
		for (const range of [...mergedOutputRanges].reverse()) {
			if (range.end - range.start <= 0.001) continue;
			rippleDeleteAllTracks(
				project.timeline,
				range.start,
				range.end,
				range.segmentIndex,
			);
		}
	}
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

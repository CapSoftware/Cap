// Utility functions for transcript formatting

import { formatTimestamp } from "@/lib/transcribe-utils";

export interface TranscriptEntry {
	id: number;
	timestamp: string | number; // Allow both string and number types
	text: string;
	startTime: number;
}

export const formatTime = (seconds: number): string => {
	return formatTimestamp(seconds * 1000);
};

export function formatChaptersAsVTT(
	chapters: { title: string; start: number }[],
): string {
	if (!chapters || chapters.length === 0) {
		return "WEBVTT\n\n";
	}

	// Sort chapters by start time
	const sortedChapters = [...chapters].sort((a, b) => a.start - b.start);

	// Generate VTT content
	let vttContent = "WEBVTT\n\n";
	sortedChapters.forEach((chapter, index) => {
		const startTime = formatTime(chapter.start);
		// Check for next chapter explicitly
		const nextChapter =
			index < sortedChapters.length - 1 ? sortedChapters[index + 1] : null;
		const endTime = nextChapter
			? formatTime(nextChapter.start)
			: formatTime(chapter.start + 60);

		vttContent += `${index + 1}\n${startTime} --> ${endTime}\n${
			chapter.title
		}\n\n`;
	});

	return vttContent;
}

/**
 * Formats transcript entries for clipboard copying
 */
export const formatTranscriptForClipboard = (
	entries: TranscriptEntry[],
): string => {
	return entries
		.map((entry) => `[${entry.timestamp}] ${entry.text}`)
		.join("\n\n");
};

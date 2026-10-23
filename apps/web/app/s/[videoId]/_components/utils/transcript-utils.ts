import { formatVttCueText } from "@/lib/transcript-vtt";

export { parseVTT } from "@/lib/transcript-vtt";
// Utility functions for transcript formatting

export interface TranscriptEntry {
	id: number;
	timestamp: string | number; // Allow both string and number types
	text: string;
	startTime: number;
	endTime?: number;
	speaker?: string | null;
}

export const formatTime = (seconds: number): string => {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);
	const milliseconds = Math.floor((seconds % 1) * 1000);

	return `${hours.toString().padStart(2, "0")}:${minutes
		.toString()
		.padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${milliseconds
		.toString()
		.padStart(3, "0")}`;
};

export const formatTimeMinutes = (time: number) => {
	const minutes = Math.floor(time / 60);
	const seconds = Math.floor(time % 60);
	return `${minutes.toString().padStart(2, "0")}:${seconds
		.toString()
		.padStart(2, "0")}`;
};

/**
 * Formats transcript entries as VTT format for subtitles
 */
export const formatTranscriptAsVTT = (entries: TranscriptEntry[]): string => {
	const vttHeader = "WEBVTT\n\n";

	const vttEntries = entries.map((entry, index) => {
		const startSeconds = entry.startTime;
		const nextEntry = entries[index + 1];
		const endSeconds =
			entry.endTime ?? (nextEntry ? nextEntry.startTime : startSeconds + 3);

		return `${entry.id}\n${formatTime(startSeconds)} --> ${formatTime(
			endSeconds,
		)}\n${formatVttCueText(entry.text, entry.speaker)}\n`;
	});

	return vttHeader + vttEntries.join("\n");
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
		.map(
			(entry) =>
				`[${entry.timestamp}] ${entry.speaker ? `Speaker ${entry.speaker}: ` : ""}${entry.text}`,
		)
		.join("\n\n");
};

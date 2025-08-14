// Utility functions for transcript formatting

export interface TranscriptEntry {
	id: number;
	timestamp: string | number; // Allow both string and number types
	text: string;
	startTime: number;
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

/**
 * Formats transcript entries as VTT format for subtitles
 */
export const formatTranscriptAsVTT = (entries: TranscriptEntry[]): string => {
	const vttHeader = "WEBVTT\n\n";

	const vttEntries = entries.map((entry, index) => {
		const startSeconds = entry.startTime;
		const nextEntry = entries[index + 1];
		const endSeconds = nextEntry ? nextEntry.startTime : startSeconds + 3;

		return `${entry.id}\n${formatTime(startSeconds)} --> ${formatTime(
			endSeconds,
		)}\n${entry.text}\n`;
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

export const parseVTT = (vttContent: string): TranscriptEntry[] => {
	const lines = vttContent.split("\n");
	const entries: TranscriptEntry[] = [];
	let currentEntry: Partial<TranscriptEntry & { startTime: number }> = {};
	let currentId = 0;

	const timeToSeconds = (timeStr: string): number | null => {
		const parts = timeStr.split(":");
		if (parts.length !== 3) return null;

		const [hoursStr, minutesStr, secondsStr] = parts;
		if (!hoursStr || !minutesStr || !secondsStr) return null;

		const hours = parseInt(hoursStr, 10);
		const minutes = parseInt(minutesStr, 10);
		const seconds = parseInt(secondsStr, 10);

		if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return null;

		return hours * 3600 + minutes * 60 + seconds;
	};

	const parseTimestamp = (
		timestamp: string,
	): { mm_ss: string; totalSeconds: number } | null => {
		const parts = timestamp.split(":");
		if (parts.length !== 3) return null;

		const [hoursStr, minutesStr, secondsWithMs] = parts;
		if (!hoursStr || !minutesStr || !secondsWithMs) return null;

		const secondsPart = secondsWithMs.split(".")[0];
		if (!secondsPart) return null;

		const totalSeconds = timeToSeconds(
			`${hoursStr}:${minutesStr}:${secondsPart}`,
		);
		if (totalSeconds === null) return null;

		return {
			mm_ss: `${minutesStr}:${secondsPart}`,
			totalSeconds,
		};
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line?.trim()) continue;

		const trimmedLine = line.trim();

		if (trimmedLine === "WEBVTT") continue;

		if (/^\d+$/.test(trimmedLine)) {
			currentId = parseInt(trimmedLine, 10);
			continue;
		}

		if (trimmedLine.includes("-->")) {
			const [startTimeStr, endTimeStr] = trimmedLine.split(" --> ");
			if (!startTimeStr || !endTimeStr) continue;

			const startTimestamp = parseTimestamp(startTimeStr);
			if (startTimestamp) {
				currentEntry = {
					id: currentId,
					timestamp: startTimestamp.mm_ss,
					startTime: startTimestamp.totalSeconds,
				};
			}
			continue;
		}

		if (currentEntry.timestamp && !currentEntry.text) {
			const textContent =
				trimmedLine.startsWith('"') && trimmedLine.endsWith('"')
					? trimmedLine.slice(1, -1)
					: trimmedLine;

			currentEntry.text = textContent;
			if (
				currentEntry.id !== undefined &&
				currentEntry.timestamp &&
				currentEntry.text &&
				currentEntry.startTime !== undefined
			) {
				entries.push(currentEntry as TranscriptEntry);
			}
			currentEntry = {};
		}
	}

	const sortedEntries = entries.sort((a, b) => a.startTime - b.startTime);
	return sortedEntries;
};

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

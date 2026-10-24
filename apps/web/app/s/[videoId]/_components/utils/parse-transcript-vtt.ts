export interface TranscriptEntry {
	id: number;
	timestamp: string;
	text: string;
	startTime: number;
	endTime: number;
}

export const parseTranscriptVTT = (vttContent: string): TranscriptEntry[] => {
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

		if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds))
			return null;

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

		const fractionPart = secondsWithMs.split(".")[1];
		const fraction = fractionPart ? Number(`0.${fractionPart}`) : 0;

		return {
			mm_ss: `${minutesStr}:${secondsPart}`,
			totalSeconds: totalSeconds + (Number.isFinite(fraction) ? fraction : 0),
		};
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line?.trim()) {
			currentEntry = {};
			continue;
		}

		const trimmedLine = line.trim();

		if (trimmedLine === "WEBVTT") continue;

		if (!currentEntry.timestamp && /^\d+$/.test(trimmedLine)) {
			currentId = parseInt(trimmedLine, 10);
			continue;
		}

		if (trimmedLine.includes("-->")) {
			const [startTimeStr, endTimeStr] = trimmedLine.split(" --> ");
			if (!startTimeStr || !endTimeStr) continue;

			const startTimestamp = parseTimestamp(startTimeStr);
			const endTimestamp = parseTimestamp(endTimeStr);
			if (startTimestamp) {
				currentEntry = {
					id: currentId,
					timestamp: startTimestamp.mm_ss,
					startTime: startTimestamp.totalSeconds,
					endTime: endTimestamp?.totalSeconds ?? startTimestamp.totalSeconds,
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

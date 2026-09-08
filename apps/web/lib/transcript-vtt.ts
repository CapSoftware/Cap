export function escapeVttText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function decodeVttText(text: string): string {
	return text.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (entity) => {
		switch (entity) {
			case "&amp;":
				return "&";
			case "&lt;":
				return "<";
			case "&gt;":
				return ">";
			case "&nbsp;":
				return "\u00a0";
			case "&lrm;":
				return "\u200e";
			case "&rlm;":
				return "\u200f";
			default:
				return entity;
		}
	});
}

export function parseVttCueText(payload: string): {
	text: string;
	speaker: string | null;
} {
	const voice = payload.match(/^\s*<v(?:\.[^\s>]*)?\s+([^>]+)>/);
	const annotation = voice?.[1]?.trim();
	return {
		text: decodeVttText(payload.replace(/<[^>]*(?:>|$)/g, "")).trim(),
		speaker: annotation
			? decodeVttText(annotation).replace(/^Speaker /, "")
			: null,
	};
}

export function formatVttCueText(
	text: string,
	speaker?: string | null,
): string {
	const escapedText = escapeVttText(normalizeTranscriptCueText(text));
	return speaker
		? `<v Speaker ${escapeVttText(normalizeTranscriptCueText(speaker))}>${escapedText}</v>`
		: escapedText;
}

export function normalizeTranscriptCueText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function updateVttEntryText(
	vttContent: string,
	entryId: number,
	newText: string,
): { content: string; updated: boolean } {
	const normalizedText = normalizeTranscriptCueText(newText);
	const lines = vttContent.split(/\r?\n/);
	const updatedLines: string[] = [];
	let index = 0;
	let updated = false;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		const trimmedLine = line.trim();

		if (!/^\d+$/.test(trimmedLine)) {
			updatedLines.push(line);
			index++;
			continue;
		}

		const cueId = parseInt(trimmedLine, 10);
		const cueStart = index;
		let cueEnd = cueStart + 1;

		while (cueEnd < lines.length && (lines[cueEnd] ?? "").trim() !== "") {
			cueEnd++;
		}

		if (cueId !== entryId) {
			updatedLines.push(...lines.slice(cueStart, cueEnd));
			if (cueEnd < lines.length) {
				updatedLines.push(lines[cueEnd] ?? "");
			}
			index = cueEnd + 1;
			continue;
		}

		const cueLines = lines.slice(cueStart, cueEnd);
		const timingIndex = cueLines.findIndex((cueLine) =>
			cueLine.includes("-->"),
		);

		if (timingIndex === -1) {
			updatedLines.push(...cueLines);
			if (cueEnd < lines.length) {
				updatedLines.push(lines[cueEnd] ?? "");
			}
			index = cueEnd + 1;
			continue;
		}

		const { speaker } = parseVttCueText(
			cueLines.slice(timingIndex + 1).join(" "),
		);
		updatedLines.push(
			...cueLines.slice(0, timingIndex + 1),
			formatVttCueText(normalizedText, speaker),
		);
		if (cueEnd < lines.length) {
			updatedLines.push(lines[cueEnd] ?? "");
		}
		updated = true;
		index = cueEnd + 1;
	}

	return {
		content: updatedLines.join("\n"),
		updated,
	};
}

export interface TranscriptEntry {
	id: number;
	timestamp: string;
	text: string;
	startTime: number;
	endTime: number;
	speaker?: string | null;
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
			const payload = [trimmedLine];
			while (
				i + 1 < lines.length &&
				lines[i + 1]?.trim() &&
				!lines[i + 1]?.includes("-->")
			) {
				i++;
				payload.push(lines[i]?.trim() ?? "");
			}
			const rawText = payload.join(" ");
			const text =
				rawText.startsWith('"') && rawText.endsWith('"')
					? rawText.slice(1, -1)
					: rawText;
			Object.assign(currentEntry, parseVttCueText(text));
			if (
				currentEntry.id !== undefined &&
				currentEntry.startTime !== undefined &&
				currentEntry.text
			) {
				entries.push(currentEntry as TranscriptEntry);
			}
			currentEntry = {};
		}
	}

	const sortedEntries = entries.sort((a, b) => a.startTime - b.startTime);
	return sortedEntries;
};

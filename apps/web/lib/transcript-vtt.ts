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

		updatedLines.push(...cueLines.slice(0, timingIndex + 1), normalizedText);
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

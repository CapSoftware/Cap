const MAX_CHUNK_LENGTH = 3_000;

function splitVtt(content: string): string[] | null {
	const blocks = content
		.replace(/\r\n?/g, "\n")
		.trim()
		.split(/\n{2,}/);
	if (!blocks[0]?.startsWith("WEBVTT") || blocks.length < 2) {
		return null;
	}
	return blocks;
}

function timestampLines(block: string): string[] {
	return block.split("\n").filter((line) => line.includes("-->"));
}

function hasCueText(block: string): boolean {
	const lines = block.split("\n");
	const timestampIndex = lines.findIndex((line) => line.includes("-->"));
	return (
		timestampIndex >= 0 &&
		lines.slice(timestampIndex + 1).some((line) => line.trim().length > 0)
	);
}

function cueIdentifier(block: string): string {
	const lines = block.split("\n");
	const timestampIndex = lines.findIndex((line) => line.includes("-->"));
	return lines.slice(0, timestampIndex).join("\n");
}

export function isCompleteTranslation(
	source: string,
	translation: string,
): boolean {
	const sourceBlocks = splitVtt(source);
	const translatedBlocks = splitVtt(translation);
	if (
		!sourceBlocks ||
		!translatedBlocks ||
		sourceBlocks.length !== translatedBlocks.length
	) {
		return false;
	}

	for (let index = 1; index < sourceBlocks.length; index++) {
		const original = sourceBlocks[index];
		const translated = translatedBlocks[index];
		if (!original || !translated) return false;

		const originalTimestamps = timestampLines(original);
		const translatedTimestamps = timestampLines(translated);
		if (
			originalTimestamps.length !== translatedTimestamps.length ||
			originalTimestamps.some(
				(line, timestampIndex) => line !== translatedTimestamps[timestampIndex],
			) ||
			(originalTimestamps.length > 0 &&
				cueIdentifier(original) !== cueIdentifier(translated)) ||
			(originalTimestamps.length === 0 && original !== translated) ||
			(originalTimestamps.length > 0 && !hasCueText(translated))
		) {
			return false;
		}
	}

	return true;
}

export function splitTranslationChunks(source: string): string[] | null {
	const blocks = splitVtt(source);
	if (!blocks) return null;

	const chunks: string[] = [];
	let current: string[] = [];
	let length = 0;

	for (const block of blocks.slice(1)) {
		if (current.length > 0 && length + block.length > MAX_CHUNK_LENGTH) {
			chunks.push(`WEBVTT\n\n${current.join("\n\n")}`);
			current = [];
			length = 0;
		}
		current.push(block);
		length += block.length + 2;
	}

	if (current.length > 0) {
		chunks.push(`WEBVTT\n\n${current.join("\n\n")}`);
	}

	return chunks;
}

export function joinTranslationChunks(
	source: string,
	chunks: string[],
	translations: string[],
): string | null {
	const sourceBlocks = splitVtt(source);
	if (!sourceBlocks || chunks.length !== translations.length) return null;

	const translatedBlocks: string[] = [];
	for (let index = 0; index < chunks.length; index++) {
		const chunk = chunks[index];
		const translation = translations[index];
		if (!chunk || !translation || !isCompleteTranslation(chunk, translation)) {
			return null;
		}
		const blocks = splitVtt(translation);
		if (!blocks) return null;
		translatedBlocks.push(...blocks.slice(1));
	}

	const result = `${sourceBlocks[0]}\n\n${translatedBlocks.join("\n\n")}`;
	return isCompleteTranslation(source, result) ? result : null;
}

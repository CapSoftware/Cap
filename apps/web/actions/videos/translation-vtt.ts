import { createHash } from "node:crypto";

const MAX_CHUNK_LENGTH = 3_000;
const SOURCE_FINGERPRINT_PREFIX = "NOTE cap-source-sha256 ";

function splitVtt(content: string): string[] | null {
	const blocks = content
		.replace(/\r\n?/g, "\n")
		.trim()
		.split(/\n{2,}/);
	if (!blocks[0]?.startsWith("WEBVTT")) {
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

function voiceAnnotations(block: string): string[] {
	const lines = block.split("\n");
	const index = lines.findIndex((line) => line.includes("-->"));
	return (
		lines
			.slice(index + 1)
			.join("\n")
			.match(/<\/?v(?:\s[^>]*)?>/g) ?? []
	);
}

function mapCuePayloads(
	content: string,
	transform: (text: string, index: number) => string,
): string | null {
	const blocks = splitVtt(content);
	if (!blocks) return null;
	return blocks
		.map((block, index) => {
			const lines = block.split("\n");
			const timing = lines.findIndex((line) => line.includes("-->"));
			if (timing < 0) return block;
			return [
				...lines.slice(0, timing + 1),
				transform(lines.slice(timing + 1).join("\n"), index),
			].join("\n");
		})
		.join("\n\n");
}

export function translationTextOnly(source: string): string | null {
	return mapCuePayloads(source, (text) =>
		text.replace(/^<v [A-Za-z0-9_-]{1,64}>([\s\S]*?)(?:<\/v>)?$/, "$1"),
	);
}

export function restoreTranslationVoices(
	source: string,
	translation: string,
): string | null {
	const textOnly = translationTextOnly(source);
	const sourceBlocks = splitVtt(source);
	if (
		!textOnly ||
		!sourceBlocks ||
		!isCompleteTranslation(textOnly, translation)
	)
		return null;
	const result = mapCuePayloads(translation, (text, index) => {
		const tags = voiceAnnotations(sourceBlocks[index] ?? "");
		return tags.length ? `${tags[0]}${text}${tags[1] ?? ""}` : text;
	});
	return result && isCompleteTranslation(source, result) ? result : null;
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
			JSON.stringify(voiceAnnotations(original)) !==
				JSON.stringify(voiceAnnotations(translated)) ||
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

	const result = [sourceBlocks[0], ...translatedBlocks].join("\n\n");
	return isCompleteTranslation(source, result) ? result : null;
}

export function sourceDigest(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

function sourceFingerprint(source: string): string {
	return `${SOURCE_FINGERPRINT_PREFIX}${sourceDigest(source)}`;
}

export function withSourceFingerprint(
	source: string,
	translation: string,
): string | null {
	const blocks = splitVtt(translation);
	if (!blocks || !isCompleteTranslation(source, translation)) return null;
	const [header, ...cues] = blocks;
	return [header, sourceFingerprint(source), ...cues].join("\n\n");
}

export function readCachedTranslation(
	source: string,
	cached: string,
): string | null {
	const blocks = splitVtt(cached);
	if (!blocks || blocks[1] !== sourceFingerprint(source)) return null;
	const translation = [blocks[0], ...blocks.slice(2)].join("\n\n");
	return isCompleteTranslation(source, translation) ? translation : null;
}

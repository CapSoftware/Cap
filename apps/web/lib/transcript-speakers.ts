export const MAX_TRANSCRIPT_SPEAKERS = 100;
export const MAX_SPEAKER_NAME_LENGTH = 80;
export type TranscriptSpeakerNames = Record<string, string>;

export function isTranscriptSpeakerId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9_-]{1,64}$/.test(value) &&
		!["__proto__", "prototype", "constructor"].includes(value)
	);
}

export function parseTranscriptSpeakerNames(
	value: unknown,
): TranscriptSpeakerNames {
	const result: TranscriptSpeakerNames = {};
	if (!value || typeof value !== "object" || Array.isArray(value))
		return result;
	const entries = Object.entries(value);
	if (entries.length > MAX_TRANSCRIPT_SPEAKERS) return result;
	for (const [id, name] of entries) {
		if (
			isTranscriptSpeakerId(id) &&
			isTranscriptSpeakerName(name) &&
			name.trim()
		) {
			result[id] = name.trim();
		}
	}
	return result;
}

export function isTranscriptSpeakerName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= MAX_SPEAKER_NAME_LENGTH &&
		!/[<>]/.test(value) &&
		![...value].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	);
}

export function transcriptSpeakerLabel(
	speaker: string | null | undefined,
	names: TranscriptSpeakerNames,
) {
	if (!speaker) return "Unknown speaker";
	return Object.hasOwn(names, speaker) ? names[speaker] : `Speaker ${speaker}`;
}

export function escapeVttText(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function decodeVttText(value: string) {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

export function parseTranscriptVoice(text: string): {
	speaker?: string;
	text: string;
} {
	const match = /^<v ([A-Za-z0-9_-]{1,64})>([\s\S]*?)(?:<\/v>)?$/.exec(text);
	if (!match || !isTranscriptSpeakerId(match[1])) return { text };
	return { speaker: match[1], text: decodeVttText(match[2] ?? "") };
}

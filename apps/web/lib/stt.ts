import { serverEnv } from "@cap/env";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
} from "@cap/web-domain";
import type { AssemblyAIEditResult } from "@/lib/edit-transcript";

export type TranscriptionProvider = "openai-compatible" | "assemblyai";

export type OpenAICompatibleTranscription = AssemblyAIEditResult & {
	audio_duration: number | null;
};

const DEFAULT_STT_MODEL = "whisper-1";
const STT_TIMEOUT_MS = 30 * 60 * 1000;

export function getTranscriptionProvider(): TranscriptionProvider | null {
	const env = serverEnv();
	if (env.STT_BASE_URL) return "openai-compatible";
	if (env.ASSEMBLY_API_KEY) return "assemblyai";
	return null;
}

export function isTranscriptionConfigured() {
	return getTranscriptionProvider() !== null;
}

type SttWord = {
	text: string;
	start: number;
	end: number;
	confidence: number | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toSttWord(raw: Record<string, unknown>): SttWord | null {
	const text = typeof raw.word === "string" ? raw.word : "";
	const start = finiteNumber(raw.start);
	const end = finiteNumber(raw.end);
	if (!text.trim() || start === null || end === null) return null;
	return {
		text,
		start: start * 1000,
		end: end * 1000,
		confidence: finiteNumber(raw.probability) ?? undefined,
	};
}

const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u;

// whisper.cpp reports BPE tokens as "words" (" timest" + "amps", " Hello" + ","),
// so tokens without a leading space are folded into the previous word. Scripts
// written without spaces (CJK) only fold punctuation.
function mergeSegmentTokens(segment: Record<string, unknown>): SttWord[] {
	if (!Array.isArray(segment.words)) return [];
	const segmentText = typeof segment.text === "string" ? segment.text : "";
	const spaceDelimited = /\s/.test(segmentText.trim());
	const merged: SttWord[] = [];

	for (const raw of segment.words.filter(isRecord)) {
		const word = toSttWord(raw);
		if (!word) continue;
		const previous = merged.at(-1);
		const continuesPrevious =
			previous !== undefined &&
			!/^\s/.test(word.text) &&
			(spaceDelimited || PUNCTUATION_ONLY.test(word.text));

		if (previous && continuesPrevious) {
			previous.text += word.text;
			previous.end = Math.max(previous.end, word.end);
			previous.confidence =
				previous.confidence === undefined || word.confidence === undefined
					? (previous.confidence ?? word.confidence)
					: Math.min(previous.confidence, word.confidence);
		} else {
			merged.push(word);
		}
	}

	return merged;
}

function collectWords(body: Record<string, unknown>): SttWord[] {
	if (Array.isArray(body.words) && body.words.length > 0) {
		return body.words
			.filter(isRecord)
			.map(toSttWord)
			.filter((word): word is SttWord => word !== null);
	}
	if (!Array.isArray(body.segments)) return [];
	return body.segments.filter(isRecord).flatMap(mergeSegmentTokens);
}

function detectLanguageCode(body: Record<string, unknown>) {
	if (typeof body.language === "string" && /^[a-z]{2,3}$/.test(body.language)) {
		return body.language;
	}
	// whisper.cpp reports full names ("english") plus a code-keyed map.
	if (isRecord(body.language_probabilities)) {
		const [best] = Object.entries(body.language_probabilities)
			.filter(
				(entry): entry is [string, number] => typeof entry[1] === "number",
			)
			.sort((left, right) => right[1] - left[1]);
		if (best) return best[0];
	}
	return null;
}

export function parseOpenAICompatibleTranscription(
	body: unknown,
	model: string,
): OpenAICompatibleTranscription {
	if (!isRecord(body)) {
		throw new Error("STT response is not a JSON object");
	}

	const words = collectWords(body).map((word) => ({
		...word,
		text: word.text.trim(),
	}));

	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (words.length === 0 && text.length > 0) {
		throw new Error(
			"STT response has text but no word timestamps; the endpoint must support response_format=verbose_json with timestamp_granularities[]=word",
		);
	}

	return {
		words,
		language_code: detectLanguageCode(body),
		speech_model_used: model,
		audio_duration: finiteNumber(body.duration),
	};
}

export async function transcribeWithOpenAICompatible(
	audio: Buffer,
	contentType: string,
	language: AiGenerationLanguage,
): Promise<OpenAICompatibleTranscription> {
	const env = serverEnv();
	if (!env.STT_BASE_URL) throw new Error("STT_BASE_URL is not set");
	const model = env.STT_MODEL ?? DEFAULT_STT_MODEL;

	const form = new FormData();
	const extension = contentType.includes("mp4") ? "m4a" : "mp3";
	form.append(
		"file",
		new Blob([new Uint8Array(audio)], { type: contentType }),
		`audio.${extension}`,
	);
	form.append("model", model);
	form.append("response_format", "verbose_json");
	form.append("timestamp_granularities[]", "word");
	form.append("temperature", "0");
	if (language !== AI_GENERATION_LANGUAGE_AUTO) {
		form.append("language", language);
	}

	const response = await fetch(
		`${env.STT_BASE_URL.replace(/\/+$/, "")}/audio/transcriptions`,
		{
			method: "POST",
			headers: env.STT_API_KEY
				? { Authorization: `Bearer ${env.STT_API_KEY}` }
				: undefined,
			body: form,
			signal: AbortSignal.timeout(STT_TIMEOUT_MS),
		},
	);

	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 500);
		throw new Error(
			`STT request failed: ${response.status} ${response.statusText} ${detail}`.trim(),
		);
	}

	return parseOpenAICompatibleTranscription(await response.json(), model);
}

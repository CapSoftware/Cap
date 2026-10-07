import { serverEnv } from "@cap/env";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
	SUPPORTED_LANGUAGES,
} from "@cap/web-domain";
import { FatalError } from "workflow";
import type { AssemblyAIEditResult } from "@/lib/edit-transcript";

export type TranscriptionProvider = "openai-compatible" | "assemblyai";

export type OpenAICompatibleTranscription = AssemblyAIEditResult & {
	audio_duration: number | null;
};

const DEFAULT_STT_MODEL = "whisper-1";
const STT_TIMEOUT_MS = 30 * 60 * 1000;
const ZERO_LENGTH_WORD_SPAN_MS = 200;

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

function positiveNumber(value: unknown) {
	const number = finiteNumber(value);
	return number !== null && number > 0 ? number : null;
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
const UNSPACED_SCRIPT =
	/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

// Some providers mark only a few word starts with a leading space, so the
// segment text is the reliable boundary source when tokens align with it.
function wordStartsFromText(tokens: SttWord[], text: unknown) {
	if (typeof text !== "string") return null;
	let cursor = 0;
	const starts: boolean[] = [];
	for (const token of tokens) {
		const core = token.text.trim();
		const index = text.indexOf(core, cursor);
		if (index === -1) return null;
		const gap = text.slice(cursor, index);
		if (gap.trim()) return null;
		starts.push(cursor === 0 || gap.length > 0 || /^\s/.test(token.text));
		cursor = index + core.length;
	}
	return starts;
}

// whisper.cpp reports BPE tokens as "words" (" timest" + "amps", " Hello" + ",").
// Unspaced scripts (CJK, Thai) only fold punctuation.
function mergeSegmentTokens(segment: Record<string, unknown>): SttWord[] {
	if (!Array.isArray(segment.words)) return [];
	const tokens = segment.words
		.filter(isRecord)
		.map(toSttWord)
		.filter((word): word is SttWord => word !== null);
	const marksWordStarts = tokens.some((token) => /^\s/.test(token.text));
	const startsFromText = wordStartsFromText(tokens, segment.text);
	const merged: SttWord[] = [];

	for (const [index, token] of tokens.entries()) {
		const previous = merged.at(-1);
		const spaced = startsFromText?.[index] ?? /^\s/.test(token.text);
		const continuesPrevious =
			previous !== undefined &&
			!spaced &&
			(PUNCTUATION_ONLY.test(token.text) ||
				((startsFromText !== null || marksWordStarts) &&
					!UNSPACED_SCRIPT.test(token.text)));

		if (previous && continuesPrevious) {
			previous.text += token.text;
			previous.end = Math.max(previous.end, token.end);
			previous.confidence =
				previous.confidence === undefined || token.confidence === undefined
					? (previous.confidence ?? token.confidence)
					: Math.min(previous.confidence, token.confidence);
		} else {
			merged.push(token);
		}
	}

	return merged;
}

// whisper.cpp gives short fillers ("Um", "Uh") start == end, which
// createEditTranscript drops. Take the span from a free gap so cuts stay safe.
function withMinimumSpan(input: SttWord[]): SttWord[] {
	const words = input.map((word) => ({ ...word }));
	for (const [index, word] of words.entries()) {
		if (word.end > word.start) continue;
		const previousEnd = words[index - 1]?.end ?? 0;
		const next = words[index + 1];
		if (next === undefined || next.start > word.start) {
			const limit = word.start + ZERO_LENGTH_WORD_SPAN_MS;
			word.end = next === undefined ? limit : Math.min(next.start, limit);
		} else if (previousEnd < word.start) {
			word.start = Math.max(previousEnd, word.start - ZERO_LENGTH_WORD_SPAN_MS);
		} else if (next.end > next.start) {
			word.end =
				word.start +
				Math.min(ZERO_LENGTH_WORD_SPAN_MS, (next.end - next.start) / 2);
			next.start = word.end;
		}
	}
	return words;
}

function collectWords(body: Record<string, unknown>): SttWord[] {
	if (Array.isArray(body.words) && body.words.length > 0) {
		return withMinimumSpan(
			body.words
				.filter(isRecord)
				.map(toSttWord)
				.filter((word): word is SttWord => word !== null),
		);
	}
	if (!Array.isArray(body.segments)) return [];
	return withMinimumSpan(
		body.segments.filter(isRecord).flatMap(mergeSegmentTokens),
	);
}

const LANGUAGE_CODES_BY_NAME = new Map<string, string>(
	Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => [
		name.toLowerCase(),
		code,
	]),
);

function detectLanguageCode(body: Record<string, unknown>) {
	if (typeof body.language === "string") {
		const language = body.language.toLowerCase();
		if (/^[a-z]{2,3}$/.test(language)) return language;
		const code = LANGUAGE_CODES_BY_NAME.get(language);
		if (code) return code;
	}
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
		throw new FatalError("STT response is not a JSON object");
	}

	const words = collectWords(body).map((word) => ({
		...word,
		text: word.text.trim(),
	}));

	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (words.length === 0 && text.length > 0) {
		throw new FatalError(
			"STT response has text but no word timestamps; the endpoint must support response_format=verbose_json with timestamp_granularities[]=word",
		);
	}

	return {
		words,
		language_code: detectLanguageCode(body),
		speech_model_used: model,
		audio_duration:
			positiveNumber(body.duration) ??
			(words.length > 0
				? Math.max(...words.map((word) => word.end)) / 1000
				: null),
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

	const endpoint = `${env.STT_BASE_URL.replace(/\/+$/, "")}/audio/transcriptions`;
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: env.STT_API_KEY
				? { Authorization: `Bearer ${env.STT_API_KEY}` }
				: undefined,
			body: form,
			redirect: "error",
			signal: AbortSignal.timeout(STT_TIMEOUT_MS),
		});
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(`STT endpoint ${endpoint} unreachable: ${cause}`);
	}

	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 500);
		const message =
			`STT request failed: ${response.status} ${response.statusText} ${detail}`.trim();
		const retryable =
			response.status >= 500 ||
			response.status === 408 ||
			response.status === 429;
		throw retryable ? new Error(message) : new FatalError(message);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new FatalError(
			`STT endpoint ${endpoint} did not return JSON; check STT_BASE_URL`,
		);
	}

	return parseOpenAICompatibleTranscription(body, model);
}

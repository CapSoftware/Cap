import type { VideoEditRange, VideoEditSpec } from "@cap/database/types";
import { formatToWebVTT } from "@/lib/transcribe-utils";
import {
	getEditSpecOutputDuration,
	mapSourceTimeToOutputTime,
	normalizeKeepRanges,
} from "@/lib/video-edits";

/**
 * Stored word transcripts are always expressed in the ORIGINAL media timeline
 * (the mp4 preserved at `videoEdits.sourceKey`) and are immutable across edits.
 * Everything shown for the current output is derived by remapping the stored
 * words through the video's cumulative edit spec.
 */
export const EDIT_TRANSCRIPT_VERSION = 3;
export const EDIT_TRANSCRIPT_KEY_SUFFIX = "transcription.edit.v3.json";
export const EDIT_TRANSCRIPT_STATUS_KEY_SUFFIX =
	"transcription.edit.v3.status.json";

export type EditTranscriptBackfillStatus = {
	status: "processing" | "error";
	requestId: string;
	requestedAt: string;
};

const MAX_CUT_PADDING_MS = 80;
const MIN_PLAYABLE_DURATION_MS = 50;
const UNKNOWN_SPEECH_MODEL = "unknown";

export type EditTranscriptWord = {
	id: string;
	text: string;
	startMs: number;
	endMs: number;
	confidence: number | null;
	speaker: string | null;
	channel: string | null;
};

export type EditTranscript = {
	version: typeof EDIT_TRANSCRIPT_VERSION;
	speechModelUsed: string;
	durationMs: number;
	languageCode: string | null;
	words: EditTranscriptWord[];
};

export type EditTranscriptGroup = {
	id: string;
	startIndex: number;
	endIndex: number;
	startMs: number;
	endMs: number;
};

export type TranscriptCutPlan = {
	startMs: number;
	endMs: number;
	safe: boolean;
	reason: "overlapping-speech" | "no-playable-output" | null;
};

export type FillerCutPlan = {
	ranges: TranscriptCutPlan[];
	fillerCount: number;
	skippedCount: number;
};

export type AssemblyAIEditWord = {
	text?: unknown;
	start?: unknown;
	end?: unknown;
	confidence?: unknown;
	speaker?: unknown;
	channel?: unknown;
};

export type AssemblyAIEditResult = {
	words?: readonly AssemblyAIEditWord[] | null;
	language_code?: unknown;
	speech_model_used?: unknown;
};

const wordMaxEndIndexes = new WeakMap<
	readonly EditTranscriptWord[],
	{ endMs: number; index: number }[]
>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown) {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return `${value}`;
	return null;
}

function clampMilliseconds(value: number, durationMs: number) {
	return Math.min(Math.max(Math.round(value), 0), durationMs);
}

function normalizeToken(text: string) {
	return text
		.trim()
		.toLocaleLowerCase()
		.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

function isExactFillerToken(token: string) {
	return (
		/^u+m+$/.test(token) ||
		/^u+h+$/.test(token) ||
		/^e+rm+$/.test(token) ||
		token === "er" ||
		/^a+h+$/.test(token) ||
		/^h+m+$/.test(token)
	);
}

export function isFillerWord(text: string) {
	return isExactFillerToken(normalizeToken(text));
}

export function createEditTranscript(
	result: AssemblyAIEditResult,
	durationMs: number,
): EditTranscript {
	const safeDurationMs =
		Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0;
	const candidates = (result.words ?? [])
		.map((word, originalIndex) => {
			const text = typeof word.text === "string" ? word.text.trim() : "";
			const rawStart = finiteNumber(word.start);
			const rawEnd = finiteNumber(word.end);
			if (!text || rawStart === null || rawEnd === null) return null;

			const startMs = clampMilliseconds(
				Math.min(rawStart, rawEnd),
				safeDurationMs,
			);
			const endMs = clampMilliseconds(
				Math.max(rawStart, rawEnd),
				safeDurationMs,
			);
			if (endMs <= startMs) return null;

			const rawConfidence = finiteNumber(word.confidence);
			return {
				originalIndex,
				text,
				startMs,
				endMs,
				confidence:
					rawConfidence === null
						? null
						: Math.min(Math.max(rawConfidence, 0), 1),
				speaker: nullableString(word.speaker),
				channel: nullableString(word.channel),
			};
		})
		.filter((word): word is NonNullable<typeof word> => word !== null)
		.sort(
			(left, right) =>
				left.startMs - right.startMs ||
				left.endMs - right.endMs ||
				left.originalIndex - right.originalIndex,
		);

	return {
		version: EDIT_TRANSCRIPT_VERSION,
		speechModelUsed:
			typeof result.speech_model_used === "string" &&
			result.speech_model_used.length > 0
				? result.speech_model_used
				: UNKNOWN_SPEECH_MODEL,
		durationMs: safeDurationMs,
		languageCode: nullableString(result.language_code),
		words: candidates.map(
			({ originalIndex: _originalIndex, ...word }, index) => ({
				...word,
				id: `word-${index}-${word.startMs}-${word.endMs}`,
			}),
		),
	};
}

export function serializeEditTranscript(transcript: EditTranscript) {
	return JSON.stringify(transcript);
}

export function parseEditTranscript(value: string): EditTranscript | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}

	if (
		!isRecord(parsed) ||
		parsed.version !== EDIT_TRANSCRIPT_VERSION ||
		typeof parsed.speechModelUsed !== "string" ||
		parsed.speechModelUsed.length === 0 ||
		typeof parsed.durationMs !== "number" ||
		!Number.isFinite(parsed.durationMs) ||
		parsed.durationMs <= 0 ||
		!Array.isArray(parsed.words)
	) {
		return null;
	}

	const languageCode =
		parsed.languageCode === null || typeof parsed.languageCode === "string"
			? parsed.languageCode
			: null;
	const words: EditTranscriptWord[] = [];

	for (const value of parsed.words) {
		if (
			!isRecord(value) ||
			typeof value.id !== "string" ||
			typeof value.text !== "string" ||
			typeof value.startMs !== "number" ||
			typeof value.endMs !== "number" ||
			!Number.isFinite(value.startMs) ||
			!Number.isFinite(value.endMs) ||
			value.startMs < 0 ||
			value.endMs <= value.startMs ||
			value.endMs > parsed.durationMs
		) {
			return null;
		}

		words.push({
			id: value.id,
			text: value.text,
			startMs: value.startMs,
			endMs: value.endMs,
			confidence:
				typeof value.confidence === "number" &&
				Number.isFinite(value.confidence)
					? Math.min(Math.max(value.confidence, 0), 1)
					: null,
			speaker: nullableString(value.speaker),
			channel: nullableString(value.channel),
		});
	}

	for (let index = 1; index < words.length; index++) {
		const previous = words[index - 1];
		const current = words[index];
		if (
			!previous ||
			!current ||
			current.startMs < previous.startMs ||
			(current.startMs === previous.startMs && current.endMs < previous.endMs)
		) {
			return null;
		}
	}

	return {
		version: EDIT_TRANSCRIPT_VERSION,
		speechModelUsed: parsed.speechModelUsed,
		durationMs: Math.round(parsed.durationMs),
		languageCode,
		words,
	};
}

/**
 * Projects a transcript stored in the ORIGINAL media timeline onto the output
 * timeline produced by `editSpec`. Words whose midpoint falls inside a cut are
 * dropped (same rule as {@link getDeletedTranscriptWordIds}); words that
 * straddle a cut boundary are clamped into the keep range they belong to.
 */
export function remapEditTranscriptThroughSpec(
	transcript: EditTranscript,
	editSpec: VideoEditSpec,
): EditTranscript {
	const spec = normalizeKeepRanges(
		editSpec.keepRanges,
		editSpec.sourceDuration,
	);
	const durationMs = Math.round(getEditSpecOutputDuration(spec) * 1000);
	const keepRanges = spec.keepRanges;
	const words: EditTranscriptWord[] = [];
	let rangeIndex = 0;

	for (const word of transcript.words) {
		const midpointSeconds = (word.startMs + word.endMs) / 2000;
		while (
			rangeIndex < keepRanges.length &&
			(keepRanges[rangeIndex]?.end ?? 0) < midpointSeconds
		) {
			rangeIndex++;
		}

		const range = keepRanges[rangeIndex];
		if (
			!range ||
			midpointSeconds < range.start ||
			midpointSeconds > range.end
		) {
			continue;
		}

		const clampedStartSeconds = Math.min(
			Math.max(word.startMs / 1000, range.start),
			range.end,
		);
		const clampedEndSeconds = Math.min(
			Math.max(word.endMs / 1000, range.start),
			range.end,
		);
		const outputStartSeconds = mapSourceTimeToOutputTime(
			clampedStartSeconds,
			spec,
		);
		if (outputStartSeconds === null) continue;

		const startMs = clampMilliseconds(outputStartSeconds * 1000, durationMs);
		const endMs = Math.max(
			clampMilliseconds(
				outputStartSeconds * 1000 +
					(clampedEndSeconds - clampedStartSeconds) * 1000,
				durationMs,
			),
			startMs + 1,
		);
		if (endMs > durationMs) continue;

		words.push({ ...word, startMs, endMs });
	}

	words.sort(
		(left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
	);

	return {
		version: EDIT_TRANSCRIPT_VERSION,
		speechModelUsed: transcript.speechModelUsed,
		durationMs,
		languageCode: transcript.languageCode,
		words,
	};
}

/**
 * Caption VTT derived from the stored words. Fillers are stripped so captions
 * stay clean even though the stored transcript is verbatim.
 */
export function editTranscriptWordsToCaptionVtt(
	words: readonly EditTranscriptWord[],
): string {
	return formatToWebVTT({
		words: words
			.filter((word) => !isFillerWord(word.text))
			.map((word) => ({
				text: word.text,
				start: word.startMs,
				end: word.endMs,
			})),
	});
}

export function getEditTranscriptObjectKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/${EDIT_TRANSCRIPT_KEY_SUFFIX}`;
}

export function getEditTranscriptStatusObjectKey(
	ownerId: string,
	videoId: string,
) {
	return `${ownerId}/${videoId}/${EDIT_TRANSCRIPT_STATUS_KEY_SUFFIX}`;
}

export function isPrivateEditTranscriptObjectKey(key: string) {
	return (
		key.endsWith(`/${EDIT_TRANSCRIPT_KEY_SUFFIX}`) ||
		key.endsWith(`/${EDIT_TRANSCRIPT_STATUS_KEY_SUFFIX}`)
	);
}

export function getEditTranscriptBackfillStatus(
	metadata: unknown,
): EditTranscriptBackfillStatus | null {
	if (!isRecord(metadata)) return null;
	const status = metadata.editTranscriptBackfill;
	if (
		!isRecord(status) ||
		(status.status !== "processing" && status.status !== "error") ||
		typeof status.requestId !== "string" ||
		status.requestId.length === 0 ||
		typeof status.requestedAt !== "string" ||
		status.requestedAt.length === 0
	) {
		return null;
	}

	return {
		status: status.status,
		requestId: status.requestId,
		requestedAt: status.requestedAt,
	};
}

export function groupEditTranscriptWords(
	words: readonly EditTranscriptWord[],
	maxWords = 48,
): EditTranscriptGroup[] {
	if (words.length === 0) return [];

	const groups: EditTranscriptGroup[] = [];
	let startIndex = 0;

	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		const nextWord = words[index + 1];
		if (!word) continue;

		const reachedLimit = index - startIndex + 1 >= maxWords;
		const punctuationBreak = /[.!?]$/.test(word.text);
		const silenceBreak = nextWord ? nextWord.startMs - word.endMs >= 800 : true;
		const speakerBreak =
			nextWord !== undefined &&
			word.speaker !== null &&
			nextWord.speaker !== null &&
			word.speaker !== nextWord.speaker;

		if (
			nextWord &&
			!reachedLimit &&
			!punctuationBreak &&
			!silenceBreak &&
			!speakerBreak
		) {
			continue;
		}

		groups.push({
			id: `group-${groups.length}-${word.startMs}`,
			startIndex,
			endIndex: index,
			startMs: words[startIndex]?.startMs ?? word.startMs,
			endMs: word.endMs,
		});
		startIndex = index + 1;
	}

	return groups;
}

export function normalizeTranscriptSelection(
	firstIndex: number,
	secondIndex: number,
	wordCount: number,
) {
	if (
		!Number.isInteger(firstIndex) ||
		!Number.isInteger(secondIndex) ||
		wordCount <= 0
	) {
		return null;
	}

	const startIndex = Math.min(firstIndex, secondIndex);
	const endIndex = Math.max(firstIndex, secondIndex);
	if (startIndex < 0 || endIndex >= wordCount) return null;
	return { startIndex, endIndex };
}

export function findActiveTranscriptWordIndex(
	words: readonly EditTranscriptWord[],
	timeMs: number,
) {
	if (!Number.isFinite(timeMs) || words.length === 0) return -1;

	let low = 0;
	let high = words.length - 1;
	let candidate = -1;

	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const word = words[middle];
		if (!word) break;
		if (word.startMs <= timeMs) {
			candidate = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	if (candidate < 0) return -1;

	const candidateWord = words[candidate];
	if (candidateWord && candidateWord.endMs >= timeMs) return candidate;

	let maxEndIndexes = wordMaxEndIndexes.get(words);
	if (!maxEndIndexes) {
		maxEndIndexes = [];
		let maximum = { endMs: Number.NEGATIVE_INFINITY, index: -1 };
		for (let index = 0; index < words.length; index++) {
			const word = words[index];
			if (word && word.endMs > maximum.endMs) {
				maximum = { endMs: word.endMs, index };
			}
			maxEndIndexes.push(maximum);
		}
		wordMaxEndIndexes.set(words, maxEndIndexes);
	}

	const active = maxEndIndexes[candidate];
	return active && active.endMs >= timeMs ? active.index : -1;
}

function getCutPadding(gapMs: number) {
	return Math.max(0, Math.min(MAX_CUT_PADDING_MS, Math.floor(gapMs / 2)));
}

function overlaps(startMs: number, endMs: number, word: EditTranscriptWord) {
	return word.startMs < endMs && word.endMs > startMs;
}

export function planTranscriptCut(
	words: readonly EditTranscriptWord[],
	firstIndex: number,
	secondIndex: number,
	durationMs: number,
): TranscriptCutPlan | null {
	const selection = normalizeTranscriptSelection(
		firstIndex,
		secondIndex,
		words.length,
	);
	if (!selection || !Number.isFinite(durationMs) || durationMs <= 0)
		return null;

	const firstWord = words[selection.startIndex];
	const lastWord = words[selection.endIndex];
	if (!firstWord || !lastWord) return null;

	const hasOutsideOverlap = words.some(
		(word, index) =>
			(index < selection.startIndex || index > selection.endIndex) &&
			overlaps(firstWord.startMs, lastWord.endMs, word),
	);
	if (hasOutsideOverlap) {
		return {
			startMs: firstWord.startMs,
			endMs: lastWord.endMs,
			safe: false,
			reason: "overlapping-speech",
		};
	}

	const previousWord = words[selection.startIndex - 1];
	const nextWord = words[selection.endIndex + 1];
	const startPadding = getCutPadding(
		firstWord.startMs - (previousWord?.endMs ?? 0),
	);
	const endPadding = getCutPadding(
		(nextWord?.startMs ?? durationMs) - lastWord.endMs,
	);
	const startMs = Math.max(0, firstWord.startMs - startPadding);
	const endMs = Math.min(durationMs, lastWord.endMs + endPadding);
	const leavesPlayableOutput =
		startMs >= MIN_PLAYABLE_DURATION_MS ||
		durationMs - endMs >= MIN_PLAYABLE_DURATION_MS;

	return {
		startMs,
		endMs,
		safe: leavesPlayableOutput,
		reason: leavesPlayableOutput ? null : "no-playable-output",
	};
}

export function planFillerCuts(
	words: readonly EditTranscriptWord[],
	durationMs: number,
): FillerCutPlan {
	const ranges: TranscriptCutPlan[] = [];
	let skippedCount = 0;
	let previousMaxEnd = 0;

	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		if (!word) continue;

		if (isFillerWord(word.text)) {
			const nextWord = words[index + 1];
			const overlappingSpeech =
				previousMaxEnd > word.startMs ||
				(nextWord !== undefined && nextWord.startMs < word.endMs);

			if (overlappingSpeech) {
				skippedCount++;
			} else {
				const startPadding = getCutPadding(word.startMs - previousMaxEnd);
				const endPadding = getCutPadding(
					(nextWord?.startMs ?? durationMs) - word.endMs,
				);
				ranges.push({
					startMs: Math.max(0, word.startMs - startPadding),
					endMs: Math.min(durationMs, word.endMs + endPadding),
					safe: true,
					reason: null,
				});
			}
		}

		previousMaxEnd = Math.max(previousMaxEnd, word.endMs);
	}

	const mergedRanges: TranscriptCutPlan[] = [];
	for (const range of ranges) {
		const previous = mergedRanges.at(-1);
		if (previous && range.startMs <= previous.endMs) {
			previous.endMs = Math.max(previous.endMs, range.endMs);
		} else {
			mergedRanges.push({ ...range });
		}
	}

	const totalDeletedMs = mergedRanges.reduce(
		(total, range) => total + range.endMs - range.startMs,
		0,
	);
	if (durationMs - totalDeletedMs < MIN_PLAYABLE_DURATION_MS) {
		return {
			ranges: [],
			fillerCount: ranges.length + skippedCount,
			skippedCount: ranges.length + skippedCount,
		};
	}

	return {
		ranges: mergedRanges,
		fillerCount: ranges.length + skippedCount,
		skippedCount,
	};
}

export function getDeletedTranscriptWordIds(
	words: readonly EditTranscriptWord[],
	keepRanges: readonly VideoEditRange[],
) {
	const deletedIds = new Set<string>();
	let rangeIndex = 0;

	for (const word of words) {
		const midpointSeconds = (word.startMs + word.endMs) / 2000;
		while (
			rangeIndex < keepRanges.length &&
			(keepRanges[rangeIndex]?.end ?? 0) < midpointSeconds
		) {
			rangeIndex++;
		}

		const range = keepRanges[rangeIndex];
		if (
			!range ||
			midpointSeconds < range.start ||
			midpointSeconds > range.end
		) {
			deletedIds.add(word.id);
		}
	}

	return deletedIds;
}

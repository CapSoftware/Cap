import type { Video } from "@cap/web-domain";
import {
	EDIT_TRANSCRIPT_VERSION,
	type EditTranscript,
	type EditTranscriptWord,
	editTranscriptWordsToCaptionVtt,
} from "@/lib/edit-transcript";
import type { NormalizedSegmentEntry } from "@/lib/segments-audio";
import { planSegmentsAudioExtraction } from "@/lib/segments-audio";

/**
 * Pure logic for the provisional live transcription of instant-mode
 * recordings: which audio segments form the next chunk, how chunk words are
 * placed on the recording timeline, and the `transcription.live.json`
 * artifact that the share page reads while the canonical transcription
 * doesn't exist yet.
 */

export const LIVE_TRANSCRIBE = {
	/** First chunk fires fast so a transcript exists almost immediately. */
	INITIAL_CHUNK_SECONDS: 5,
	/** Steady-state window. Small on purpose: the untranscribed tail at stop
	 * averages half this, and that tail is all that stands between "stop" and
	 * a complete transcript on the share page. */
	MAX_CHUNK_SECONDS: 10,
	GROW_AFTER_CHUNKS: 2,
	/** Catch-up bound: one chunk never covers more audio than this. */
	MAX_CHUNK_TAKE_SECONDS: 60,
	/** Hard cost cap: stop live-transcribing after this much audio; the
	 * canonical post-stop transcription covers the full recording anyway. */
	MAX_TRANSCRIBED_SECONDS: 60 * 60,
	/** Hard backstop on chunk count (1h at 10s windows = 360). */
	MAX_CHUNKS: 420,
	POLL_INTERVAL_MS: 3_000,
	/** One waiting step holds its invocation at most this long. */
	MAX_POLL_MS_PER_STEP: 120_000,
	/** Consecutive empty waiting steps before giving up (~8 minutes). */
	MAX_IDLE_STEPS: 4,
	/** Attempts per chunk before it is skipped so one poison chunk can never
	 * wedge the loop or burn retries forever. */
	MAX_CHUNK_ATTEMPTS: 2,
	/** A chunk sent with context takes over from the previous chunk about
	 * this far before its cut, so it hears the cut words whole. */
	CONTEXT_HANDOVER_MS: 2_000,
	/** The exact join may move this far either side of the handover point to
	 * land on a word both chunks heard. */
	HANDOVER_SEARCH_MS: 1_000,
	/** Two chunks' copies of a word may disagree on its start by this much. */
	HANDOVER_MATCH_MS: 300,
} as const;

export function chunkHandoverMs(chunkStartMs: number, contextMs: number) {
	if (contextMs <= 0) return 0;
	return Math.min(LIVE_TRANSCRIBE.CONTEXT_HANDOVER_MS, contextMs, chunkStartMs);
}

export type LiveChunkDecision =
	| { action: "wait" }
	| { action: "no-audio" }
	| { action: "done" }
	| {
			action: "chunk";
			entries: NormalizedSegmentEntry[];
			startMs: number;
			durationMs: number;
			/** Already transcribed segments sent ahead of `entries` so the
			 * chunk doesn't start mid-sentence with no left context. */
			context: NormalizedSegmentEntry[];
			contextMs: number;
	  };

/**
 * Choose the next contiguous run of unprocessed audio segments. Segments
 * after an index gap are never taken (a missing upload would silently shift
 * every later word), so a mid-recording gap pauses live transcription and a
 * gap in a completed manifest ends it.
 */
export function planNextLiveChunk(options: {
	manifest: Video.SegmentManifestType;
	lastProcessedIndex: number;
	targetSeconds: number;
	maxTakeSeconds?: number;
	contextSeconds?: number;
}): LiveChunkDecision {
	const { manifest, lastProcessedIndex, targetSeconds } = options;
	const contextSeconds = options.contextSeconds ?? 0;
	const maxTakeSeconds =
		options.maxTakeSeconds ?? LIVE_TRANSCRIBE.MAX_CHUNK_TAKE_SECONDS;

	const plan = planSegmentsAudioExtraction(manifest, {
		requireComplete: false,
	});
	if (plan.status === "no-audio") {
		return manifest.is_complete ? { action: "no-audio" } : { action: "wait" };
	}
	if (plan.status !== "ok") {
		return { action: "wait" };
	}

	let startMs = 0;
	const processed: NormalizedSegmentEntry[] = [];
	const pending: NormalizedSegmentEntry[] = [];
	let expectedIndex = plan.entries[0]?.index === 0 ? 0 : 1;

	for (const entry of plan.entries) {
		if (entry.index !== expectedIndex) break;
		expectedIndex++;

		if (entry.index <= lastProcessedIndex) {
			startMs += entry.duration * 1000;
			processed.push(entry);
		} else {
			pending.push(entry);
		}
	}

	if (pending.length === 0) {
		return manifest.is_complete ? { action: "done" } : { action: "wait" };
	}

	const taken: NormalizedSegmentEntry[] = [];
	let takenSeconds = 0;
	for (const entry of pending) {
		if (taken.length > 0 && takenSeconds + entry.duration > maxTakeSeconds) {
			break;
		}
		taken.push(entry);
		takenSeconds += entry.duration;
		if (takenSeconds >= maxTakeSeconds) break;
	}

	const tookEverything = taken.length === pending.length;
	if (!manifest.is_complete && tookEverything && takenSeconds < targetSeconds) {
		return { action: "wait" };
	}

	const context: NormalizedSegmentEntry[] = [];
	let contextTaken = 0;
	for (let i = processed.length - 1; i >= 0; i--) {
		if (contextTaken >= contextSeconds) break;
		const entry = processed[i] as NormalizedSegmentEntry;
		context.unshift(entry);
		contextTaken += entry.duration;
	}

	return {
		action: "chunk",
		entries: taken,
		startMs: Math.round(startMs),
		durationMs: Math.round(takenSeconds * 1000),
		context,
		contextMs: Math.round(contextTaken * 1000),
	};
}

export interface LiveChunkWordInput {
	text?: unknown;
	start?: unknown;
	end?: unknown;
	confidence?: unknown;
	speaker?: unknown;
}

/** Place a chunk's AssemblyAI words (ms from the start of the sent audio,
 * which begins with `contextMs` of context) on the recording timeline. Context
 * words land before `chunkStartMs`; applyChunkToLiveTranscript decides which
 * of them replace the previous chunk's. Words outside the audio bounds are
 * clamped, invalid ones dropped. */
export function offsetChunkWords(
	words: readonly LiveChunkWordInput[] | null | undefined,
	chunkStartMs: number,
	chunkDurationMs: number,
	contextMs = 0,
): EditTranscriptWord[] {
	const result: EditTranscriptWord[] = [];

	for (const [index, word] of (words ?? []).entries()) {
		const text = typeof word.text === "string" ? word.text.trim() : "";
		const start = typeof word.start === "number" ? word.start : null;
		const end = typeof word.end === "number" ? word.end : null;
		if (!text || start === null || end === null || !Number.isFinite(start)) {
			continue;
		}

		const clamp = (value: number) =>
			Math.min(
				Math.max(Math.round(value - contextMs), -contextMs),
				chunkDurationMs,
			);
		const startMs = chunkStartMs + clamp(start);
		const endMs = chunkStartMs + Math.max(clamp(end), clamp(start));

		result.push({
			id: `live-${chunkStartMs}-${index}`,
			text,
			startMs,
			endMs,
			confidence: typeof word.confidence === "number" ? word.confidence : null,
			speaker: typeof word.speaker === "string" ? word.speaker : null,
			channel: null,
		});
	}

	return result;
}

/**
 * AssemblyAI reports speech-free audio as a transcript error when language
 * detection is enabled. For chunked live transcription that's a valid empty
 * chunk (pauses in narration are normal), not a failure to retry.
 */
export function isNoSpokenAudioError(transcript: {
	status: string;
	error?: string | null;
}): boolean {
	return (
		transcript.status === "error" &&
		/no spoken audio/i.test(transcript.error ?? "")
	);
}

export const LIVE_TRANSCRIPT_VERSION = 1;

export type LiveTranscriptState = "active" | "complete" | "stopped";

export interface LiveTranscriptArtifact {
	version: typeof LIVE_TRANSCRIPT_VERSION;
	state: LiveTranscriptState;
	languageCode: string | null;
	lastAudioSegmentIndex: number;
	transcribedDurationMs: number;
	words: EditTranscriptWord[];
	vtt: string;
	updatedAt: string;
	/** A chunk was skipped after repeated failures, so some speech is missing.
	 * Disqualifies the artifact from being promoted to the canonical
	 * transcript; the full-pass fallback covers the recording instead. */
	hasGaps?: boolean;
}

export function getLiveTranscriptObjectKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/transcription.live.json`;
}

/** Sentinel for "nothing processed yet": 0 is a legitimate segment index in
 * 0-based manifests, so the cursor starts below every real index. */
export const LIVE_TRANSCRIPT_NO_SEGMENTS = -1;

export function createEmptyLiveTranscript(
	nowIso: string,
): LiveTranscriptArtifact {
	return {
		version: LIVE_TRANSCRIPT_VERSION,
		state: "active",
		languageCode: null,
		lastAudioSegmentIndex: LIVE_TRANSCRIPT_NO_SEGMENTS,
		transcribedDurationMs: 0,
		words: [],
		vtt: editTranscriptWordsToCaptionVtt([]),
		updatedAt: nowIso,
		hasGaps: false,
	};
}

export function parseLiveTranscript(
	value: string,
): LiveTranscriptArtifact | null {
	try {
		const parsed = JSON.parse(value) as Partial<LiveTranscriptArtifact>;
		if (
			parsed?.version !== LIVE_TRANSCRIPT_VERSION ||
			!Array.isArray(parsed.words) ||
			typeof parsed.vtt !== "string" ||
			typeof parsed.lastAudioSegmentIndex !== "number" ||
			typeof parsed.transcribedDurationMs !== "number"
		) {
			return null;
		}
		return {
			version: LIVE_TRANSCRIPT_VERSION,
			state:
				parsed.state === "complete" || parsed.state === "stopped"
					? parsed.state
					: "active",
			languageCode:
				typeof parsed.languageCode === "string" ? parsed.languageCode : null,
			lastAudioSegmentIndex: parsed.lastAudioSegmentIndex,
			transcribedDurationMs: parsed.transcribedDurationMs,
			words: parsed.words,
			vtt: parsed.vtt,
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
			hasGaps: parsed.hasGaps === true,
		};
	} catch {
		return null;
	}
}

/**
 * Whether the live transcript fully and faithfully covers the recording, so
 * it can be promoted to the canonical transcript instead of paying for a
 * second full transcription pass. Anything short of complete gap-free
 * coverage means the full-pass fallback runs exactly as before.
 */
export function canPromoteLiveTranscript(
	artifact: LiveTranscriptArtifact,
	manifest: Video.SegmentManifestType,
): { ok: true } | { ok: false; reason: string } {
	if (!manifest.is_complete) {
		return { ok: false, reason: "manifest is not complete" };
	}
	if (artifact.hasGaps) {
		return { ok: false, reason: "live transcript has skipped chunks" };
	}

	const plan = planSegmentsAudioExtraction(manifest);
	if (plan.status === "no-audio") {
		return { ok: false, reason: "recording has no audio" };
	}
	if (plan.status !== "ok") {
		return { ok: false, reason: plan.reason };
	}

	const lastIndex = plan.entries[plan.entries.length - 1]?.index;
	if (lastIndex === undefined || artifact.lastAudioSegmentIndex !== lastIndex) {
		return {
			ok: false,
			reason: `covered up to segment ${artifact.lastAudioSegmentIndex} of ${lastIndex}`,
		};
	}

	// A manifest index gap means audio the recording had but we never saw.
	let expected = plan.entries[0]?.index ?? 1;
	for (const entry of plan.entries) {
		if (entry.index !== expected) {
			return { ok: false, reason: `segment gap at index ${expected}` };
		}
		expected++;
	}

	return { ok: true };
}

/**
 * Shape the accumulated live words as a canonical edit transcript (v3). The
 * caption VTT derives from the same words via editTranscriptWordsToCaptionVtt,
 * exactly as the full-pass path does.
 */
export function liveTranscriptToEditTranscript(
	artifact: LiveTranscriptArtifact,
	speechModelUsed: string,
): EditTranscript {
	const durationMs = Math.max(0, Math.round(artifact.transcribedDurationMs));
	return {
		version: EDIT_TRANSCRIPT_VERSION,
		speechModelUsed,
		durationMs,
		languageCode: artifact.languageCode,
		words: orderLiveTranscriptWords(artifact.words, durationMs),
	};
}

/**
 * parseEditTranscript rejects a transcript whose starts go backwards or whose
 * words have no length, and both can come out of chunked transcription: two
 * chunks time the same moment up to HANDOVER_MATCH_MS apart at a join, and a
 * word clamped to a chunk's end is zero-length. Nudge such words into order
 * instead of letting one make the whole promoted transcript unreadable.
 */
export function orderLiveTranscriptWords(
	words: readonly EditTranscriptWord[],
	durationMs: number,
): EditTranscriptWord[] {
	if (durationMs < 1) return [];
	const result: EditTranscriptWord[] = [];
	let previous: EditTranscriptWord | undefined;
	for (const word of words) {
		const startMs = Math.min(
			Math.max(word.startMs, previous?.startMs ?? 0),
			durationMs - 1,
		);
		let endMs = Math.min(Math.max(word.endMs, startMs + 1), durationMs);
		if (previous && startMs === previous.startMs) {
			endMs = Math.max(endMs, previous.endMs);
		}
		previous = { ...word, startMs, endMs };
		result.push(previous);
	}
	return result;
}

const normalizeWordText = (text: string) =>
	text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

function alignedRun(
	previous: EditTranscriptWord[],
	a: number,
	next: EditTranscriptWord[],
	b: number,
) {
	const same = (offset: number) => {
		const left = previous[a + offset];
		const right = next[b + offset];
		return (
			left !== undefined &&
			right !== undefined &&
			normalizeWordText(left.text) === normalizeWordText(right.text)
		);
	};
	let run = 0;
	for (let offset = -1; offset >= -8 && same(offset); offset--) run++;
	for (let offset = 1; offset <= 8 && same(offset); offset++) run++;
	return run;
}

/**
 * Join the previous words to a chunk sent with context. Both heard the audio
 * around `targetMs` but may time the same word slightly differently, so a
 * fixed cut could keep both copies or neither. Join on the word both heard
 * (same text, close start) nearest the target; if they share none, cut there.
 */
function joinAtHandover(
	previous: EditTranscriptWord[],
	next: EditTranscriptWord[],
	targetMs: number,
	minMs: number,
	maxMs: number,
): EditTranscriptWord[] {
	const anchors = next
		.map((word, index) => ({ word, index }))
		.filter(({ word }) => word.startMs >= minMs && word.startMs <= maxMs)
		.sort(
			(a, b) =>
				Math.abs(a.word.startMs - targetMs) -
				Math.abs(b.word.startMs - targetMs),
		);
	for (const { word, index } of anchors) {
		const text = normalizeWordText(word.text);
		if (!text) continue;
		// A repeated word ("no, no, no") has several nearby copies: take the one
		// where the most surrounding words line up, then the closest start.
		let match: number | undefined;
		let best = { run: 0, distance: Number.POSITIVE_INFINITY };
		for (const [candidate, other] of previous.entries()) {
			const distance = Math.abs(other.startMs - word.startMs);
			if (
				distance > LIVE_TRANSCRIBE.HANDOVER_MATCH_MS ||
				normalizeWordText(other.text) !== text
			) {
				continue;
			}
			const run = alignedRun(previous, candidate, next, index);
			if (run > best.run || (run === best.run && distance < best.distance)) {
				best = { run, distance };
				match = candidate;
			}
		}
		if (match !== undefined) {
			return [...previous.slice(0, match), ...next.slice(index)];
		}
	}

	return [
		...previous.filter((word) => word.startMs < targetMs),
		...next.filter((word) => word.startMs >= targetMs),
	];
}

/**
 * Merge one transcribed chunk into the artifact. Idempotent per chunk range:
 * a retried chunk first evicts any words at or after its start, or past its
 * join with the previous words when it was sent with context.
 */
export function applyChunkToLiveTranscript(
	artifact: LiveTranscriptArtifact,
	chunk: {
		startMs: number;
		durationMs: number;
		contextMs?: number;
		lastAudioSegmentIndex: number;
		words: EditTranscriptWord[];
		languageCode: string | null;
		nowIso: string;
	},
): LiveTranscriptArtifact {
	const contextMs = chunk.contextMs ?? 0;
	const handoverMs = chunkHandoverMs(chunk.startMs, contextMs);
	const targetMs = chunk.startMs - handoverMs;
	const joined =
		handoverMs > 0
			? joinAtHandover(
					artifact.words,
					chunk.words,
					targetMs,
					Math.max(
						targetMs - LIVE_TRANSCRIBE.HANDOVER_SEARCH_MS,
						chunk.startMs - contextMs,
					),
					Math.min(
						targetMs + LIVE_TRANSCRIBE.HANDOVER_SEARCH_MS,
						chunk.startMs,
					),
				)
			: [
					...artifact.words.filter((word) => word.startMs < chunk.startMs),
					...chunk.words,
				];
	const transcribedDurationMs = Math.max(
		artifact.transcribedDurationMs,
		chunk.startMs + chunk.durationMs,
	);
	const words = orderLiveTranscriptWords(joined, transcribedDurationMs);

	return {
		...artifact,
		languageCode: artifact.languageCode ?? chunk.languageCode,
		lastAudioSegmentIndex: Math.max(
			artifact.lastAudioSegmentIndex,
			chunk.lastAudioSegmentIndex,
		),
		transcribedDurationMs,
		words,
		vtt: editTranscriptWordsToCaptionVtt(words),
		updatedAt: chunk.nowIso,
	};
}

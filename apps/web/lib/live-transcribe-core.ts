import type { Video } from "@cap/web-domain";
import {
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
	/** Chunk window while the recording is young — favors low latency. */
	INITIAL_CHUNK_SECONDS: 15,
	/** Chunk window after GROW_AFTER_CHUNKS — favors fewer, cheaper calls. */
	MAX_CHUNK_SECONDS: 30,
	GROW_AFTER_CHUNKS: 6,
	/** Catch-up bound: one chunk never covers more audio than this. */
	MAX_CHUNK_TAKE_SECONDS: 60,
	/** Hard cost cap: stop live-transcribing after this much audio; the
	 * canonical post-stop transcription covers the full recording anyway. */
	MAX_TRANSCRIBED_SECONDS: 60 * 60,
	/** Hard backstop on chunk count (MAX_TRANSCRIBED / INITIAL implies ~240). */
	MAX_CHUNKS: 300,
	POLL_INTERVAL_MS: 3_000,
	/** One waiting step holds its invocation at most this long. */
	MAX_POLL_MS_PER_STEP: 120_000,
	/** Consecutive empty waiting steps before giving up (~8 minutes). */
	MAX_IDLE_STEPS: 4,
	/** Attempts per chunk before it is skipped so one poison chunk can never
	 * wedge the loop or burn retries forever. */
	MAX_CHUNK_ATTEMPTS: 2,
} as const;

export type LiveChunkDecision =
	| { action: "wait" }
	| { action: "no-audio" }
	| { action: "done" }
	| {
			action: "chunk";
			entries: NormalizedSegmentEntry[];
			startMs: number;
			durationMs: number;
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
}): LiveChunkDecision {
	const { manifest, lastProcessedIndex, targetSeconds } = options;
	const maxTakeSeconds =
		options.maxTakeSeconds ?? LIVE_TRANSCRIBE.MAX_CHUNK_TAKE_SECONDS;

	const plan = planSegmentsAudioExtraction(manifest, { requireComplete: false });
	if (plan.status === "no-audio") {
		return manifest.is_complete ? { action: "no-audio" } : { action: "wait" };
	}
	if (plan.status !== "ok") {
		return { action: "wait" };
	}

	let startMs = 0;
	const pending: NormalizedSegmentEntry[] = [];
	let expectedIndex = plan.entries[0]?.index === 0 ? 0 : 1;

	for (const entry of plan.entries) {
		if (entry.index !== expectedIndex) break;
		expectedIndex++;

		if (entry.index <= lastProcessedIndex) {
			startMs += entry.duration * 1000;
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

	return {
		action: "chunk",
		entries: taken,
		startMs: Math.round(startMs),
		durationMs: Math.round(takenSeconds * 1000),
	};
}

export interface LiveChunkWordInput {
	text?: unknown;
	start?: unknown;
	end?: unknown;
	confidence?: unknown;
	speaker?: unknown;
}

/** Place a chunk's AssemblyAI words (chunk-relative ms) on the recording
 * timeline. Words outside the chunk bounds are clamped, invalid ones dropped. */
export function offsetChunkWords(
	words: readonly LiveChunkWordInput[] | null | undefined,
	chunkStartMs: number,
	chunkDurationMs: number,
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
			Math.min(Math.max(Math.round(value), 0), chunkDurationMs);
		const startMs = chunkStartMs + clamp(start);
		const endMs = chunkStartMs + Math.max(clamp(end), clamp(start));

		result.push({
			id: `live-${chunkStartMs}-${index}`,
			text,
			startMs,
			endMs,
			confidence:
				typeof word.confidence === "number" ? word.confidence : null,
			speaker: typeof word.speaker === "string" ? word.speaker : null,
			channel: null,
		});
	}

	return result;
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
}

export function getLiveTranscriptObjectKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/transcription.live.json`;
}

export function createEmptyLiveTranscript(nowIso: string): LiveTranscriptArtifact {
	return {
		version: LIVE_TRANSCRIPT_VERSION,
		state: "active",
		languageCode: null,
		lastAudioSegmentIndex: 0,
		transcribedDurationMs: 0,
		words: [],
		vtt: editTranscriptWordsToCaptionVtt([]),
		updatedAt: nowIso,
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
			updatedAt:
				typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
		};
	} catch {
		return null;
	}
}

/**
 * Merge one transcribed chunk into the artifact. Idempotent per chunk range:
 * a retried chunk first evicts any words at or after its start.
 */
export function applyChunkToLiveTranscript(
	artifact: LiveTranscriptArtifact,
	chunk: {
		startMs: number;
		durationMs: number;
		lastAudioSegmentIndex: number;
		words: EditTranscriptWord[];
		languageCode: string | null;
		nowIso: string;
	},
): LiveTranscriptArtifact {
	const words = [
		...artifact.words.filter((word) => word.startMs < chunk.startMs),
		...chunk.words,
	];

	return {
		...artifact,
		languageCode: artifact.languageCode ?? chunk.languageCode,
		lastAudioSegmentIndex: Math.max(
			artifact.lastAudioSegmentIndex,
			chunk.lastAudioSegmentIndex,
		),
		transcribedDurationMs: Math.max(
			artifact.transcribedDurationMs,
			chunk.startMs + chunk.durationMs,
		),
		words,
		vtt: editTranscriptWordsToCaptionVtt(words),
		updatedAt: chunk.nowIso,
	};
}

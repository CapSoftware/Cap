import type { ConnectionLevel } from "../../../apps/desktop/src/routes/editor/connection-status";

export type ConnectionSample = {
	online: boolean;
	media: { bitsPerSecond: number | null; latencyMs: number | null };
	/// `navigator.connection`, where the browser has it. Only a hint: Chrome
	/// rounds and caps it, and Safari and Firefox don't have it.
	hint: {
		effectiveType?: string;
		downlinkMbps?: number;
		rttMs?: number;
	} | null;
};

export type ConnectionBasis = "media" | "hint";

export type ConnectionReading = {
	level: ConnectionLevel;
	basis: ConnectionBasis;
};

/// At or above this, playback and seeks keep up with a screen recording.
export const GOOD_MBPS = 8;
/// Below this, playback regularly waits for video.
export const FAIR_MBPS = 2;
/// Above this, every seek visibly waits on the round trip.
export const FAIR_LATENCY_MS = 700;
export const POOR_LATENCY_MS = 1500;
/// How far past a boundary a reading must go to cross it, so one that sits
/// near it doesn't flip back and forth.
const BAND = 0.25;

const RANK = { poor: 0, fair: 1, good: 2 } as const;
type Rank = 0 | 1 | 2;
const LEVELS = ["poor", "fair", "good"] as const;

/// Leans toward the side of the boundary the last level was on.
function clears(value: number, boundary: number, wasAbove: boolean | null) {
	if (wasAbove === null) return value >= boundary;
	return wasAbove
		? value >= boundary * (1 - BAND)
		: value >= boundary * (1 + BAND);
}

function under(value: number, boundary: number, wasUnder: boolean | null) {
	if (wasUnder === null) return value < boundary;
	return wasUnder
		? value < boundary * (1 + BAND)
		: value < boundary * (1 - BAND);
}

function rankFor(
	mbps: number | null,
	latencyMs: number | null,
	previous: Rank | null,
): Rank | null {
	if (mbps === null && latencyMs === null) return null;
	let rank: Rank = 2;
	if (mbps !== null) {
		rank = clears(mbps, GOOD_MBPS, previous === null ? null : previous >= 2)
			? 2
			: clears(mbps, FAIR_MBPS, previous === null ? null : previous >= 1)
				? 1
				: 0;
	}
	if (latencyMs !== null) {
		const latencyRank: Rank = under(
			latencyMs,
			FAIR_LATENCY_MS,
			previous === null ? null : previous >= 2,
		)
			? 2
			: under(
						latencyMs,
						POOR_LATENCY_MS,
						previous === null ? null : previous >= 1,
					)
				? 1
				: 0;
		rank = Math.min(rank, latencyRank) as Rank;
	}
	return rank;
}

function hintRank(
	hint: NonNullable<ConnectionSample["hint"]>,
	previous: Rank | null,
): Rank | null {
	const fromType: Rank | null =
		hint.effectiveType === "slow-2g" || hint.effectiveType === "2g"
			? 0
			: hint.effectiveType === "3g"
				? 1
				: null;
	// Chrome reports 0 for both when it has no estimate yet.
	const mbps =
		hint.downlinkMbps !== undefined && hint.downlinkMbps > 0
			? hint.downlinkMbps
			: null;
	const rtt = hint.rttMs !== undefined && hint.rttMs > 0 ? hint.rttMs : null;
	const fromNumbers = rankFor(mbps, rtt, previous);
	if (fromType === null) return fromNumbers;
	if (fromNumbers === null) return fromType;
	return Math.min(fromType, fromNumbers) as Rank;
}

/// The browser's hint stands in only until media reads have said anything.
export function classifyConnection(
	sample: ConnectionSample,
	previous: ConnectionLevel | null = null,
): ConnectionReading | null {
	if (!sample.online) return { level: "offline", basis: "media" };
	const previousRank =
		previous === null || previous === "offline" ? null : RANK[previous];
	const media = rankFor(
		sample.media.bitsPerSecond === null
			? null
			: sample.media.bitsPerSecond / 1_000_000,
		sample.media.latencyMs,
		previousRank,
	);
	if (media !== null) return { level: LEVELS[media], basis: "media" };
	const hint = sample.hint ? hintRank(sample.hint, previousRank) : null;
	if (hint !== null) return { level: LEVELS[hint], basis: "hint" };
	return null;
}

/// A new level must hold for `confirmSamples` samples in a row so it doesn't
/// flicker, except going offline or back online, the first reading, and the
/// first measured one after the browser's hint. Between media reads the last
/// level stands, since an idle connection isn't a worse one.
export function createConnectionTracker(confirmSamples = 2) {
	let current: ConnectionReading | null = null;
	let candidate: ConnectionLevel | null = null;
	let candidateCount = 0;
	const set = (next: ConnectionReading) => {
		const changed = next.level !== current?.level;
		current = next;
		candidate = null;
		candidateCount = 0;
		return changed ? next.level : null;
	};
	return {
		get level() {
			return current?.level ?? null;
		},
		get basis() {
			return current?.basis ?? null;
		},
		update(sample: ConnectionSample): ConnectionLevel | null {
			// Only a measured level widens the boundaries; the browser's hint
			// is too rough to lean on.
			const reading = classifyConnection(
				sample,
				current?.basis === "media" ? current.level : null,
			);
			if (!reading) {
				candidate = null;
				candidateCount = 0;
				return null;
			}
			if (
				current === null ||
				reading.level === "offline" ||
				current.level === "offline" ||
				(current.basis === "hint" && reading.basis === "media")
			)
				return set(reading);
			if (current.basis === "media" && reading.basis === "hint") {
				candidate = null;
				candidateCount = 0;
				return null;
			}
			if (reading.level === current.level) {
				current = reading;
				candidate = null;
				candidateCount = 0;
				return null;
			}
			if (reading.level !== candidate) {
				candidate = reading.level;
				candidateCount = 0;
			}
			candidateCount++;
			return candidateCount >= confirmSamples ? set(reading) : null;
		},
	};
}

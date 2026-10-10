import type { ConnectionLevel } from "../../../apps/desktop/src/routes/editor/connection-status";

export type ConnectionEvidence = {
	reads: number;
	bytes: number;
	waitedMs: number;
	ageMs: number;
};

export type MediaReading = {
	bitsPerSecond: number | null;
	latencyMs: number | null;
	evidence: ConnectionEvidence;
};

export type ConnectionSample = {
	online: boolean;
	/// Reads since the first frame painted.
	media: MediaReading & {
		/// Reads before it, while the editor's own downloads shared the link.
		startup?: MediaReading;
	};
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

/// A first verdict needs several reads over at least a second, and either
/// enough bytes to time or seconds of waiting on the network, so one slow
/// request can't call a connection slow.
export const MIN_EVIDENCE: ConnectionEvidence = {
	reads: 3,
	bytes: 1024 * 1024,
	waitedMs: 4000,
	ageMs: 1000,
};

export function enoughConnectionEvidence(evidence: ConnectionEvidence) {
	return (
		evidence.reads >= MIN_EVIDENCE.reads &&
		evidence.ageMs >= MIN_EVIDENCE.ageMs &&
		(evidence.bytes >= MIN_EVIDENCE.bytes ||
			evidence.waitedMs >= MIN_EVIDENCE.waitedMs)
	);
}

const RANK = { poor: 0, fair: 1, good: 2 } as const;
type Rank = 0 | 1 | 2;
const LEVELS = ["poor", "fair", "good"] as const;

/// Leans toward the side of the boundary the last level was on.
function clears(value: number, boundary: number, wasAbove: boolean) {
	return wasAbove
		? value >= boundary * (1 - BAND)
		: value >= boundary * (1 + BAND);
}

function under(value: number, boundary: number, wasUnder: boolean) {
	return wasUnder
		? value < boundary * (1 + BAND)
		: value < boundary * (1 - BAND);
}

function rankFor(
	mbps: number | null,
	latencyMs: number | null,
	previous: Rank,
): Rank | null {
	if (mbps === null && latencyMs === null) return null;
	let rank: Rank = 2;
	if (mbps !== null) {
		rank = clears(mbps, GOOD_MBPS, previous >= 2)
			? 2
			: clears(mbps, FAIR_MBPS, previous >= 1)
				? 1
				: 0;
	}
	if (latencyMs !== null) {
		const latencyRank: Rank = under(latencyMs, FAIR_LATENCY_MS, previous >= 2)
			? 2
			: under(latencyMs, POOR_LATENCY_MS, previous >= 1)
				? 1
				: 0;
		rank = Math.min(rank, latencyRank) as Rank;
	}
	return rank;
}

/// The level from one sample, or null while there's nothing to judge by.
/// With no verdict yet it waits for enough evidence and then gives the
/// benefit of the doubt: a reading near a boundary lands on the better side,
/// so "slow" is said only of a connection that is clearly slow.
export function classifyConnection(
	sample: ConnectionSample,
	previous: ConnectionLevel | null = null,
): ConnectionLevel | null {
	if (!sample.online) return "offline";
	const first = previous === null || previous === "offline";
	const level = (reading: MediaReading, rankBefore: Rank) => {
		const rank = rankFor(
			reading.bitsPerSecond === null ? null : reading.bitsPerSecond / 1_000_000,
			reading.latencyMs,
			rankBefore,
		);
		return rank === null ? null : LEVELS[rank];
	};
	if (!first) return level(sample.media, RANK[previous]);
	if (enoughConnectionEvidence(sample.media.evidence))
		return level(sample.media, 2);
	// Startup reads only ever look slower than the connection is, so they can
	// show it is good but never that it isn't; an editor that reads nothing
	// once it has opened still gets a verdict that way.
	// A fast editor paints its first frame well within a second, so startup
	// reads are judged by count and bytes, not by how long they spread over.
	const startup = sample.media.startup;
	if (
		startup &&
		startup.evidence.reads >= MIN_EVIDENCE.reads &&
		startup.evidence.bytes >= MIN_EVIDENCE.bytes
	)
		return level(startup, 2) === "good" ? "good" : null;
	return null;
}

/// A new level must hold for `confirmSamples` samples in a row so it doesn't
/// flicker, except going offline or back online and the first verdict.
/// Between media reads the last level stands, since an idle connection isn't
/// a worse one.
export function createConnectionTracker(confirmSamples = 2) {
	let current: ConnectionLevel | null = null;
	let candidate: ConnectionLevel | null = null;
	let candidateCount = 0;
	const set = (next: ConnectionLevel) => {
		const changed = next !== current;
		current = next;
		candidate = null;
		candidateCount = 0;
		return changed ? next : null;
	};
	return {
		get level() {
			return current;
		},
		update(sample: ConnectionSample): ConnectionLevel | null {
			const reading = classifyConnection(sample, current);
			if (reading === null) {
				// Back online with nothing new measured yet: checking again.
				if (current === "offline") {
					current = null;
				}
				candidate = null;
				candidateCount = 0;
				return null;
			}
			if (current === null || reading === "offline" || current === "offline")
				return set(reading);
			if (reading === current) {
				candidate = null;
				candidateCount = 0;
				return null;
			}
			if (reading !== candidate) {
				candidate = reading;
				candidateCount = 0;
			}
			candidateCount++;
			return candidateCount >= confirmSamples ? set(reading) : null;
		},
	};
}

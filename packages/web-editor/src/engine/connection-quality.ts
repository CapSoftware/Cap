import type { ConnectionLevel } from "../app/routes/editor/connection-status";

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
	media: MediaReading & {
		startup?: MediaReading;
	};
};

export const GOOD_MBPS = 8;
export const FAIR_MBPS = 2;
export const FAIR_LATENCY_MS = 700;
export const POOR_LATENCY_MS = 1500;
const BAND = 0.25;

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

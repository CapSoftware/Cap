import { describe, expect, test } from "bun:test";
import {
	type ConnectionEvidence,
	type ConnectionSample,
	classifyConnection,
	createConnectionTracker,
	enoughConnectionEvidence,
	MIN_EVIDENCE,
} from "./connection-quality";

const plenty: ConnectionEvidence = {
	reads: 12,
	bytes: 8 * 1024 * 1024,
	waitedMs: 6000,
	ageMs: 10_000,
};

const media = (
	mbps: number | null,
	latencyMs: number | null = null,
	evidence: ConnectionEvidence = plenty,
): ConnectionSample => ({
	online: true,
	media: {
		bitsPerSecond: mbps === null ? null : mbps * 1_000_000,
		latencyMs,
		evidence,
	},
});

const offline: ConnectionSample = { ...media(null), online: false };

describe("enoughConnectionEvidence", () => {
	test("needs several reads over a few seconds", () => {
		expect(enoughConnectionEvidence(MIN_EVIDENCE)).toBe(true);
		expect(
			enoughConnectionEvidence({
				...MIN_EVIDENCE,
				reads: MIN_EVIDENCE.reads - 1,
			}),
		).toBe(false);
		expect(enoughConnectionEvidence({ ...plenty, ageMs: 500 })).toBe(false);
	});

	test("and either enough bytes to time or long enough waiting", () => {
		expect(
			enoughConnectionEvidence({ ...plenty, bytes: 4096, waitedMs: 500 }),
		).toBe(false);
		expect(enoughConnectionEvidence({ ...plenty, bytes: 4096 })).toBe(true);
		expect(enoughConnectionEvidence({ ...plenty, waitedMs: 500 })).toBe(true);
	});
});

describe("classifyConnection", () => {
	test("says nothing until there is enough evidence", () => {
		const thin = { ...plenty, reads: 1 };
		expect(classifyConnection(media(0.5, 2000, thin))).toBeNull();
		expect(classifyConnection(media(50, 40, thin))).toBeNull();
		expect(classifyConnection(media(null, null))).toBeNull();
	});

	test("rates the editor's media reads", () => {
		expect(classifyConnection(media(40, 60))).toBe("good");
		expect(classifyConnection(media(4, 150))).toBe("fair");
		expect(classifyConnection(media(1, 400))).toBe("poor");
	});

	test("a first verdict near a boundary lands on the better side", () => {
		// Under 8 Mbps, but not clearly: good, not fair.
		expect(classifyConnection(media(6.5))).toBe("good");
		// Under 2 Mbps, but not clearly: fair, not slow.
		expect(classifyConnection(media(1.6))).toBe("fair");
		expect(classifyConnection(media(1.4))).toBe("poor");
		expect(classifyConnection(media(40, 1800))).toBe("fair");
		expect(classifyConnection(media(40, 1900))).toBe("poor");
	});

	test("slow responses cap an otherwise fast connection", () => {
		expect(classifyConnection(media(40, 900), "good")).toBe("fair");
		expect(classifyConnection(media(40, 2000), "fair")).toBe("poor");
	});

	test("startup reads can show a connection is good, never that it isn't", () => {
		const nothingSince = (startupMbps: number, latencyMs: number) => ({
			online: true,
			media: {
				...media(null, null, { ...plenty, reads: 0, bytes: 0, waitedMs: 0 })
					.media,
				startup: {
					bitsPerSecond: startupMbps * 1_000_000,
					latencyMs,
					evidence: plenty,
				},
			},
		});
		expect(classifyConnection(nothingSince(80, 20))).toBe("good");
		// A first frame within a second still leaves enough to go on.
		const quick = nothingSince(80, 20);
		if (quick.media.startup)
			quick.media.startup.evidence = { ...plenty, reads: 16, ageMs: 640 };
		expect(classifyConnection(quick)).toBe("good");
		// But not one read, however large.
		const single = nothingSince(80, 20);
		if (single.media.startup)
			single.media.startup.evidence = { ...plenty, reads: 1 };
		expect(classifyConnection(single)).toBeNull();
		expect(classifyConnection(nothingSince(3, 20))).toBeNull();
		expect(classifyConnection(nothingSince(0.3, 2000))).toBeNull();
		// Reads since the first frame decide when there are enough of them.
		const both = nothingSince(80, 20);
		both.media = { ...media(1, 400).media, startup: both.media.startup };
		expect(classifyConnection(both)).toBe("poor");
	});

	test("offline wins over everything, with or without evidence", () => {
		expect(classifyConnection(offline)).toBe("offline");
	});

	test("after a verdict, a reading near a boundary leans toward it", () => {
		expect(classifyConnection(media(7), "good")).toBe("good");
		expect(classifyConnection(media(7), "fair")).toBe("fair");
		expect(classifyConnection(media(9), "fair")).toBe("fair");
		expect(classifyConnection(media(10.5), "fair")).toBe("good");
		expect(classifyConnection(media(1.7), "fair")).toBe("fair");
		expect(classifyConnection(media(1.4), "fair")).toBe("poor");
		expect(classifyConnection(media(2.2), "poor")).toBe("poor");
		expect(classifyConnection(media(2.6), "poor")).toBe("fair");
	});
});

describe("createConnectionTracker", () => {
	test("stays checking until there is evidence, then decides at once", () => {
		const tracker = createConnectionTracker();
		const thin = { ...plenty, reads: 2 };
		expect(tracker.update(media(0.3, 3000, thin))).toBeNull();
		expect(tracker.level).toBeNull();
		expect(tracker.update(media(40, 50))).toBe("good");
	});

	test("a new level must hold for two samples before it shows", () => {
		const tracker = createConnectionTracker();
		tracker.update(media(40, 50));
		expect(tracker.update(media(1))).toBeNull();
		expect(tracker.level).toBe("good");
		expect(tracker.update(media(1))).toBe("poor");
	});

	test("a single dip doesn't flicker the level", () => {
		const tracker = createConnectionTracker();
		tracker.update(media(40, 50));
		const shown = [
			media(1),
			media(40),
			media(1.5),
			media(30),
			media(1),
			media(40),
		].map((sample) => tracker.update(sample));
		expect(shown.every((level) => level === null)).toBe(true);
		expect(tracker.level).toBe("good");
	});

	test("going offline applies at once, and back online decides afresh", () => {
		const tracker = createConnectionTracker();
		tracker.update(media(40));
		expect(tracker.update(offline)).toBe("offline");
		expect(tracker.update(media(4))).toBe("fair");
	});

	test("back online with nothing measured is checking again", () => {
		const tracker = createConnectionTracker();
		tracker.update(media(40));
		tracker.update(offline);
		expect(tracker.update(media(null, null))).toBeNull();
		expect(tracker.level).toBeNull();
	});

	test("between media reads the last measured level stands", () => {
		const tracker = createConnectionTracker();
		tracker.update(media(1));
		expect(tracker.update(media(null, null))).toBeNull();
		expect(tracker.update(media(null, null))).toBeNull();
		expect(tracker.level).toBe("poor");
	});
});

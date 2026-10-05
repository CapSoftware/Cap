import { describe, expect, test } from "bun:test";
import {
	type ConnectionSample,
	classifyConnection,
	createConnectionTracker,
} from "./connection-quality";

const media = (
	mbps: number | null,
	latencyMs: number | null = null,
	hint: ConnectionSample["hint"] = null,
): ConnectionSample => ({
	online: true,
	media: {
		bitsPerSecond: mbps === null ? null : mbps * 1_000_000,
		latencyMs,
	},
	hint,
});

const offline: ConnectionSample = {
	online: false,
	media: { bitsPerSecond: null, latencyMs: null },
	hint: null,
};

describe("classifyConnection", () => {
	test("rates the editor's media reads", () => {
		expect(classifyConnection(media(40, 60))?.level).toBe("good");
		expect(classifyConnection(media(5, 150))?.level).toBe("fair");
		expect(classifyConnection(media(1.5, 400))?.level).toBe("poor");
	});

	test("slow responses cap an otherwise fast connection", () => {
		expect(classifyConnection(media(40, 900))?.level).toBe("fair");
		expect(classifyConnection(media(40, 2000))?.level).toBe("poor");
		expect(classifyConnection(media(null, 2000))?.level).toBe("poor");
	});

	test("offline wins over everything", () => {
		expect(classifyConnection({ ...media(40, 50), online: false })).toEqual({
			level: "offline",
			basis: "media",
		});
	});

	test("uses navigator.connection only until media reads say something", () => {
		const hint = { effectiveType: "3g", downlinkMbps: 1.4, rttMs: 300 };
		expect(classifyConnection(media(null, null, hint))).toEqual({
			level: "poor",
			basis: "hint",
		});
		expect(
			classifyConnection(media(null, null, { effectiveType: "3g" })),
		).toEqual({ level: "fair", basis: "hint" });
		expect(classifyConnection(media(40, 50, hint))).toEqual({
			level: "good",
			basis: "media",
		});
	});

	test("ignores Chrome's zero placeholders and knows nothing without data", () => {
		expect(
			classifyConnection(
				media(null, null, { effectiveType: "4g", downlinkMbps: 0, rttMs: 0 }),
			),
		).toBeNull();
		expect(classifyConnection(media(null, null))).toBeNull();
	});

	test("a reading near a boundary leans toward the level already shown", () => {
		// 7 Mbps is under the 8 Mbps line, but within its band.
		expect(classifyConnection(media(7), "good")?.level).toBe("good");
		expect(classifyConnection(media(7), "fair")?.level).toBe("fair");
		expect(classifyConnection(media(7), null)?.level).toBe("fair");
		// Crossing up takes clearly clearing the line.
		expect(classifyConnection(media(9), "fair")?.level).toBe("fair");
		expect(classifyConnection(media(10.5), "fair")?.level).toBe("good");
		// And falling out takes clearly dropping below it.
		expect(classifyConnection(media(1.7), "fair")?.level).toBe("fair");
		expect(classifyConnection(media(1.4), "fair")?.level).toBe("poor");
		expect(classifyConnection(media(2.2), "poor")?.level).toBe("poor");
		expect(classifyConnection(media(2.6), "poor")?.level).toBe("fair");
	});
});

describe("createConnectionTracker", () => {
	test("takes the first reading at once", () => {
		const tracker = createConnectionTracker();
		expect(tracker.update(media(1.5, 400))).toBe("poor");
		expect(tracker.level).toBe("poor");
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
			media(1.5),
			media(40),
			media(2),
			media(30),
			media(1),
			media(40),
		].map((sample) => tracker.update(sample));
		expect(shown.every((level) => level === null)).toBe(true);
		expect(tracker.level).toBe("good");
	});

	test("a candidate that changes restarts the count", () => {
		const tracker = createConnectionTracker();
		tracker.update(media(40));
		expect(tracker.update(media(5))).toBeNull();
		expect(tracker.update(media(1))).toBeNull();
		expect(tracker.update(media(1))).toBe("poor");
	});

	test("going offline and back applies at once", () => {
		const tracker = createConnectionTracker();
		tracker.update(media(40));
		expect(tracker.update(offline)).toBe("offline");
		expect(tracker.update(media(5))).toBe("fair");
	});

	test("the first media reading replaces the browser's hint at once", () => {
		const tracker = createConnectionTracker();
		expect(
			tracker.update(
				media(null, null, { effectiveType: "4g", downlinkMbps: 10 }),
			),
		).toBe("good");
		expect(tracker.basis).toBe("hint");
		expect(tracker.update(media(1.5, 400))).toBe("poor");
		expect(tracker.basis).toBe("media");
	});

	test("between media reads the last measured level stands", () => {
		const tracker = createConnectionTracker();
		tracker.update(media(1.5));
		const hint = { effectiveType: "4g", downlinkMbps: 10, rttMs: 50 };
		expect(tracker.update(media(null, null, hint))).toBeNull();
		expect(tracker.update(media(null, null, hint))).toBeNull();
		expect(tracker.update(media(null, null))).toBeNull();
		expect(tracker.level).toBe("poor");
	});
});

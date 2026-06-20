import { describe, expect, it } from "vitest";
import {
	clearTimelineDraft,
	getTimelineDraftKey,
	parseTimelineDraft,
	readTimelineDraft,
	serializeTimelineDraft,
	type TimelineDraftStorage,
	writeTimelineDraft,
} from "@/lib/video-edit-drafts";
import {
	areTimelineStatesEquivalent,
	createTimelineState,
	splitTimelineAt,
} from "@/lib/video-edits";

class MemoryTimelineDraftStorage implements TimelineDraftStorage {
	readonly values = new Map<string, string>();

	getItem(key: string) {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string) {
		this.values.set(key, value);
	}

	removeItem(key: string) {
		this.values.delete(key);
	}
}

function createThrowingStorage(): TimelineDraftStorage {
	return {
		getItem() {
			throw new Error("blocked");
		},
		setItem() {
			throw new Error("blocked");
		},
		removeItem() {
			throw new Error("blocked");
		},
	};
}

describe("video edit draft storage", () => {
	it("creates stable per-video storage keys", () => {
		expect(getTimelineDraftKey("video-1")).toBe(
			"cap:edit-timeline-draft:video-1",
		);
	});

	it("serializes and parses a split-only draft", () => {
		const state = splitTimelineAt(createTimelineState(10), 5);
		const parsed = parseTimelineDraft(serializeTimelineDraft(10, state), 10);

		expect(parsed).not.toBeNull();
		if (!parsed) throw new Error("Expected parsed draft");
		expect(parsed.splitPoints).toEqual([5]);
		expect(areTimelineStatesEquivalent(state, parsed)).toBe(true);
	});

	it("rejects invalid, stale, or mismatched drafts", () => {
		const state = splitTimelineAt(createTimelineState(10), 5);
		const raw = serializeTimelineDraft(10, state);
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		expect(parseTimelineDraft("not json", 10)).toBeNull();
		expect(
			parseTimelineDraft(JSON.stringify({ ...parsed, version: 0 }), 10),
		).toBeNull();
		expect(parseTimelineDraft(raw, 12)).toBeNull();
		expect(
			parseTimelineDraft(
				JSON.stringify({
					...parsed,
					state: { ...state, splitPoints: ["bad"] },
				}),
				10,
			),
		).toBeNull();
	});

	it("reads, writes, and clears drafts through injected storage", () => {
		const storage = new MemoryTimelineDraftStorage();
		const key = getTimelineDraftKey("video-1");
		const state = splitTimelineAt(createTimelineState(10), 4);

		writeTimelineDraft(storage, key, 10, state);
		const restored = readTimelineDraft(storage, key, 10);

		expect(restored).not.toBeNull();
		if (!restored) throw new Error("Expected restored draft");
		expect(areTimelineStatesEquivalent(state, restored)).toBe(true);

		clearTimelineDraft(storage, key);
		expect(readTimelineDraft(storage, key, 10)).toBeNull();
	});

	it("treats storage failures as unavailable drafts", () => {
		const storage = createThrowingStorage();
		const key = getTimelineDraftKey("video-1");
		const state = splitTimelineAt(createTimelineState(10), 4);

		expect(readTimelineDraft(storage, key, 10)).toBeNull();
		expect(() => writeTimelineDraft(storage, key, 10, state)).not.toThrow();
		expect(() => clearTimelineDraft(storage, key)).not.toThrow();
	});
});

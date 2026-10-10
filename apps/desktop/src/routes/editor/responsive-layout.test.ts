import { describe, expect, it } from "vitest";
import { tapOpensSheet } from "./responsive-layout";

const tap = (over: Partial<Parameters<typeof tapOpensSheet>[0]>) =>
	tapOpensSheet({
		selectionBefore: "",
		selectionAfter: "zoom:0",
		distance: 0,
		onTrackLane: true,
		...over,
	});

describe("tapOpensSheet", () => {
	it("opens for a tap that selects a segment", () => {
		expect(tap({})).toBe(true);
	});

	it("reopens for a tap on the segment that's already selected", () => {
		expect(tap({ selectionBefore: "zoom:0" })).toBe(true);
	});

	it("stays shut for a click elsewhere that leaves the selection alone", () => {
		expect(tap({ selectionBefore: "zoom:0", onTrackLane: false })).toBe(false);
	});

	it("stays shut after a drag or when nothing is selected", () => {
		expect(tap({ distance: 12 })).toBe(false);
		expect(tap({ selectionAfter: "" })).toBe(false);
	});
});

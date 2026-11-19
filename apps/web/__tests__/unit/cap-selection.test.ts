import { describe, expect, it } from "vitest";
import {
	deselectPage,
	pageSelectionState,
	selectPage,
	toggleSelection,
} from "@/lib/cap-selection";

const page = ["a", "b", "c", "d", "e", "f"];

const toggle = (
	selected: string[],
	anchorId: string | null,
	targetId: string,
	shiftKey = false,
) =>
	toggleSelection({ orderedIds: page, selected, anchorId, targetId, shiftKey });

describe("toggleSelection", () => {
	it("toggles a single Cap and makes it the anchor", () => {
		expect(toggle([], null, "c")).toEqual({ selected: ["c"], anchorId: "c" });
		expect(toggle(["c"], "c", "c")).toEqual({ selected: [], anchorId: "c" });
	});

	it("selects the whole range between the anchor and a shift-clicked Cap", () => {
		const first = toggle([], null, "b");
		expect(toggle(first.selected, first.anchorId, "e", true)).toEqual({
			selected: ["b", "c", "d", "e"],
			anchorId: "e",
		});
	});

	it("selects backwards ranges in page order", () => {
		expect(toggle(["e"], "e", "b", true).selected).toEqual([
			"b",
			"c",
			"d",
			"e",
		]);
	});

	it("deselects a range when the shift-clicked Cap was already selected", () => {
		expect(toggle(["a", "b", "c", "d", "e"], "a", "d", true).selected).toEqual([
			"e",
		]);
	});

	it("keeps Caps already selected outside the range", () => {
		expect(toggle(["a", "f"], "c", "d", true).selected).toEqual([
			"a",
			"c",
			"d",
			"f",
		]);
	});

	it("falls back to a single toggle when there is no anchor on this page", () => {
		expect(toggle([], null, "d", true).selected).toEqual(["d"]);
		expect(toggle([], "z", "d", true).selected).toEqual(["d"]);
	});

	it("keeps selections from other pages", () => {
		expect(toggle(["x1", "x2"], "b", "c").selected).toEqual(["x1", "x2", "c"]);
	});
});

describe("page selection", () => {
	it("reports none, some and all", () => {
		expect(pageSelectionState(page, [])).toBe("none");
		expect(pageSelectionState(page, ["a", "x"])).toBe("some");
		expect(pageSelectionState(page, [...page])).toBe("all");
		expect(pageSelectionState([], ["a"])).toBe("none");
	});

	it("selects and clears the page without touching other pages", () => {
		expect(selectPage(["a", "b"], ["x", "a"])).toEqual(["x", "a", "b"]);
		expect(deselectPage(["a", "b"], ["x", "a", "b"])).toEqual(["x"]);
	});
});

import { describe, expect, it } from "vitest";
import {
	nextInOrder,
	positionChanges,
	reorderIds,
	spaceVideoOrderFromSettings,
} from "@/lib/space-video-order";

const ids = ["a", "b", "c", "d", "e"];

describe("reorderIds", () => {
	it("moves a Cap before or after another", () => {
		expect(reorderIds(ids, ["e"], { type: "before", targetId: "b" })).toEqual([
			"a",
			"e",
			"b",
			"c",
			"d",
		]);
		expect(reorderIds(ids, ["a"], { type: "after", targetId: "c" })).toEqual([
			"b",
			"c",
			"a",
			"d",
			"e",
		]);
	});

	it("moves a selection as one block in its current order", () => {
		expect(
			reorderIds(ids, ["d", "b"], { type: "before", targetId: "a" }),
		).toEqual(["b", "d", "a", "c", "e"]);
	});

	it("moves to the start, end, one earlier and one later", () => {
		expect(reorderIds(ids, ["c"], { type: "start" })).toEqual([
			"c",
			"a",
			"b",
			"d",
			"e",
		]);
		expect(reorderIds(ids, ["c"], { type: "end" })).toEqual([
			"a",
			"b",
			"d",
			"e",
			"c",
		]);
		expect(reorderIds(ids, ["c"], { type: "earlier" })).toEqual([
			"a",
			"c",
			"b",
			"d",
			"e",
		]);
		expect(reorderIds(ids, ["c"], { type: "later" })).toEqual([
			"a",
			"b",
			"d",
			"c",
			"e",
		]);
	});

	it("keeps the ends stable", () => {
		expect(reorderIds(ids, ["a"], { type: "earlier" })).toEqual(ids);
		expect(reorderIds(ids, ["e"], { type: "later" })).toEqual(ids);
	});

	it("ignores unknown ids and targets", () => {
		expect(reorderIds(ids, ["zz"], { type: "start" })).toEqual(ids);
		expect(reorderIds(ids, ["a"], { type: "before", targetId: "zz" })).toEqual(
			ids,
		);
	});

	it("leaves the order alone when dropping a Cap onto itself", () => {
		expect(reorderIds(ids, ["c"], { type: "before", targetId: "c" })).toEqual(
			ids,
		);
	});
});

describe("positionChanges", () => {
	it("assigns dense positions to every unplaced Cap", () => {
		expect(
			positionChanges(
				[
					{ id: "a", position: null },
					{ id: "b", position: null },
				],
				["b", "a"],
			),
		).toEqual([
			{ id: "b", position: 0 },
			{ id: "a", position: 1 },
		]);
	});

	it("only rewrites the rows whose position changed", () => {
		const current = ids.map((id, position) => ({ id, position }));
		expect(positionChanges(current, ["b", "a", "c", "d", "e"])).toEqual([
			{ id: "b", position: 0 },
			{ id: "a", position: 1 },
		]);
		expect(positionChanges(current, ids)).toEqual([]);
	});
});

describe("space order helpers", () => {
	it("defaults to newest first for old or unknown settings", () => {
		expect(spaceVideoOrderFromSettings(null)).toBe("newest");
		expect(spaceVideoOrderFromSettings({})).toBe("newest");
		expect(spaceVideoOrderFromSettings({ videoOrder: "random" })).toBe(
			"newest",
		);
		expect(spaceVideoOrderFromSettings({ videoOrder: "custom" })).toBe(
			"custom",
		);
	});

	it("finds the next Cap and stops at the end", () => {
		expect(nextInOrder(ids, "b")).toBe("c");
		expect(nextInOrder(ids, "e")).toBeNull();
		expect(nextInOrder(ids, "zz")).toBeNull();
	});
});

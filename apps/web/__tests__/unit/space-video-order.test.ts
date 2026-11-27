import { describe, expect, it } from "vitest";
import {
	nextInOrder,
	positionChanges,
	reorderIds,
	reorderIdsWithinGroups,
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

describe("reorderIdsWithinGroups", () => {
	const mixed = [
		{ id: "v1", group: "videos" },
		{ id: "n1", group: "notes" },
		{ id: "v2", group: "videos" },
		{ id: "i1", group: "images" },
		{ id: "v3", group: "videos" },
		{ id: "n2", group: "notes" },
	];

	it("steps past caps of other kinds so every move shows in its section", () => {
		expect(reorderIdsWithinGroups(mixed, ["v3"], { type: "earlier" })).toEqual([
			"v1",
			"n1",
			"v3",
			"i1",
			"v2",
			"n2",
		]);
		expect(reorderIdsWithinGroups(mixed, ["n1"], { type: "later" })).toEqual([
			"v1",
			"n2",
			"v2",
			"i1",
			"v3",
			"n1",
		]);
	});

	it("moves to the start of its own kind and leaves the others in place", () => {
		expect(reorderIdsWithinGroups(mixed, ["n2"], { type: "start" })).toEqual([
			"v1",
			"n2",
			"v2",
			"i1",
			"v3",
			"n1",
		]);
	});

	it("ignores a drop on a cap of another kind", () => {
		expect(
			reorderIdsWithinGroups(mixed, ["v1"], { type: "after", targetId: "n2" }),
		).toEqual(mixed.map((row) => row.id));
	});

	it("moves only the caps that share the target's kind", () => {
		expect(
			reorderIdsWithinGroups(mixed, ["v1", "n1"], {
				type: "after",
				targetId: "v3",
			}),
		).toEqual(["v2", "n1", "v3", "i1", "v1", "n2"]);
	});

	it("matches reorderIds when every cap is the same kind", () => {
		const videos = ids.map((id) => ({ id, group: "videos" }));
		for (const placement of [
			{ type: "earlier" },
			{ type: "later" },
			{ type: "start" },
			{ type: "end" },
			{ type: "before", targetId: "a" },
		] as const)
			expect(reorderIdsWithinGroups(videos, ["c"], placement)).toEqual(
				reorderIds(ids, ["c"], placement),
			);
	});
});

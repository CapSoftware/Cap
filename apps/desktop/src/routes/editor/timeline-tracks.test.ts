import { describe, expect, it } from "vitest";
import {
	getOverlayTrackRows,
	getOverlayZIndex,
	moveOverlayTrack,
	moveTrackLane,
	type OverlayTrack,
	removeOverlayTrack,
	resolveOverlayOrder,
	trackInsertionIndex,
} from "./timelineTracks";

const segments = () => [
	{ name: "back", track: 0, start: 0, end: 4 },
	{ name: "middle", track: 1, start: 1, end: 5 },
	{ name: "front", track: 2, start: 0, end: 4 },
	{ name: "later front", track: 2, start: 5, end: 8 },
];

describe("layer order", () => {
	it("moves a whole lane to the front without changing timing or selection indices", () => {
		const items = segments();
		const selected = items[1];
		moveTrackLane(items, 0, 2);
		expect(items.map((item) => item.track)).toEqual([2, 0, 1, 1]);
		expect(items[1]).toBe(selected);
		expect(items.map(({ start, end }) => [start, end])).toEqual([
			[0, 4],
			[1, 5],
			[0, 4],
			[5, 8],
		]);
	});

	it("moves a lane behind its siblings and can restore the original order", () => {
		const items = segments();
		moveTrackLane(items, 2, 0);
		expect(items.map((item) => item.track)).toEqual([1, 2, 0, 0]);
		moveTrackLane(items, 0, 2);
		expect(items).toEqual(segments());
	});

	it("supports empty lanes without collapsing them", () => {
		const items = [segments()[0], segments()[2]];
		moveTrackLane(items, 1, 2);
		expect(items.map((item) => item.track)).toEqual([0, 1]);
	});

	it("ignores invalid drops", () => {
		for (const [from, to] of [
			[0, 0],
			[-1, 0],
			[0, -1],
			[0.5, 1],
			[0, Number.NaN],
		]) {
			const items = segments();
			moveTrackLane(items, from, to);
			expect(items).toEqual(segments());
		}
	});
});

const visualStack: OverlayTrack[] = [
	{ kind: "text", track: 0 },
	{ kind: "image", track: 0 },
	{ kind: "mask", track: 0 },
];

describe("mixed visual layers", () => {
	it("preserves legacy compositing order when no custom order exists", () => {
		expect(resolveOverlayOrder(visualStack)).toEqual(visualStack);
	});

	it("moves an image above text without renumbering either lane", () => {
		const moved = moveOverlayTrack(visualStack, visualStack[1], 0);
		expect(moved).toEqual([visualStack[1], visualStack[0], visualStack[2]]);
		expect(moveOverlayTrack(moved, visualStack[1], 1)).toEqual(visualStack);
	});

	it("discards stale and duplicate entries and places newly added layers in front", () => {
		const added: OverlayTrack = { kind: "image", track: 1 };
		const saved: OverlayTrack[] = [
			visualStack[1],
			visualStack[1],
			{ kind: "mask", track: 9 },
			visualStack[0],
		];
		expect(resolveOverlayOrder([added, ...visualStack], saved)).toEqual([
			added,
			visualStack[2],
			visualStack[1],
			visualStack[0],
		]);
	});

	it("preserves inactive layers and matches canvas hit order", () => {
		const project = {
			overlayOrder: [visualStack[1], visualStack[0]],
			timeline: {
				textSegments: [{ track: 0, start: 0, end: 1 }],
				imageSegments: [{ track: 0, start: 10, end: 11 }],
			},
		};
		expect(getOverlayTrackRows(project)).toEqual([
			visualStack[1],
			visualStack[0],
		]);
		expect(getOverlayZIndex(project, "image", 0)).toBeGreaterThan(
			getOverlayZIndex(project, "text", 0),
		);
	});

	it("remaps references when an entire lane is deleted", () => {
		const order: OverlayTrack[] = [{ kind: "image", track: 2 }, ...visualStack];
		expect(removeOverlayTrack(order, "image", 0)).toEqual([
			{ kind: "image", track: 1 },
			visualStack[0],
			visualStack[2],
		]);
	});

	it("accepts gaps and outside row centers as insertion slots", () => {
		expect(trackInsertionIndex([100, 160, 220], 50)).toBe(0);
		expect(trackInsertionIndex([100, 160, 220], 130)).toBe(1);
		expect(trackInsertionIndex([100, 160, 220], 190)).toBe(2);
		expect(trackInsertionIndex([100, 160, 220], 270)).toBe(3);
	});
});

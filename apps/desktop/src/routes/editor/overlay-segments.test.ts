import {
	createEffect,
	createRoot,
	createSignal,
	mapArray,
	onCleanup,
} from "solid-js";
import { createStore } from "solid-js/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOverlaySegments } from "./overlay-segments";

vi.mock("solid-js", () => vi.importActual("solid-js/dist/solid.js"));
// Keep the store inside Vite so its signals use the same client runtime.
vi.mock("solid-js/store", () =>
	vi.importActual("solid-js/store/dist/store.js?client"),
);

type Segment = {
	name: string;
	enabled: boolean;
	start: number;
	end: number;
	track?: number;
	center: { x: number; y: number };
};

const segment = (name: string, track = 0): Segment => ({
	name,
	enabled: true,
	start: 0,
	end: 10,
	track,
	center: { x: 0.5, y: 0.5 },
});

const disposers: (() => void)[] = [];

function fixture(segments: Segment[] = [segment("text")]) {
	return createRoot((dispose) => {
		disposers.push(dispose);
		const [state, setState] = createStore({ segments });
		const [time, setTime] = createSignal(0);
		const overlays = createOverlaySegments(() => state.segments, time);
		let mounts = 0;
		let cleanups = 0;
		const children = mapArray(overlays.visible, ({ segment, index }) => {
			mounts += 1;
			onCleanup(() => {
				cleanups += 1;
			});
			return () => ({ segment, index });
		});
		createEffect(children);
		return {
			state,
			setState,
			setTime,
			indexed: overlays.indexed,
			visible: overlays.visible,
			children: () => children().map((child) => child()),
			counts: () => ({ mounts, cleanups }),
		};
	});
}

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

describe("preview overlay lifetime", () => {
	it("keeps visible children mounted across every playback and scrub tick", () => {
		const value = fixture();
		const entry = value.visible()[0];
		for (let frame = 1; frame <= 60; frame += 1) {
			value.setTime(frame / 60);
			expect(value.visible()[0]).toBe(entry);
		}
		value.setTime(0.25);
		expect(value.counts()).toEqual({ mounts: 1, cleanups: 0 });
	});

	it("updates properties and stacking order without restarting child state", () => {
		const value = fixture([segment("back"), segment("front", 1)]);
		const back = value.visible()[0];
		value.setState("segments", 0, "name", "edited text");
		value.setState("segments", 0, "center", "x", 0.75);
		value.setState("segments", 0, "track", 2);
		expect(value.visible()[1]).toBe(back);
		expect(value.children().map(({ segment }) => segment.name)).toEqual([
			"front",
			"edited text",
		]);
		expect(value.children()[1].segment.center.x).toBe(0.75);
		expect(value.counts()).toEqual({ mounts: 2, cleanups: 0 });
	});

	it("still mounts and removes overlays at visibility boundaries", () => {
		const value = fixture();
		value.setTime(10);
		expect(value.children()).toEqual([]);
		value.setTime(9);
		value.setState("segments", 0, "enabled", false);
		expect(value.children()).toEqual([]);
		value.setState("segments", 0, "enabled", true);
		value.setState("segments", 0, "start", 9.5);
		expect(value.children()).toEqual([]);
		value.setTime(9.5);
		expect(value.children()).toHaveLength(1);
		value.setState("segments", 0, "end", 9.5);
		expect(value.children()).toEqual([]);
		expect(value.counts()).toEqual({ mounts: 4, cleanups: 4 });
	});

	it("retains existing entries when an unrelated segment is appended", () => {
		const value = fixture();
		const entry = value.visible()[0];
		value.setState("segments", 1, segment("new image", 1));
		expect(value.visible()[0]).toBe(entry);
		expect(value.children().map(({ index }) => index)).toEqual([0, 1]);
		expect(value.counts()).toEqual({ mounts: 2, cleanups: 0 });
	});

	it("refreshes captured indices when segments are reordered or removed", () => {
		const value = fixture([segment("first"), segment("second")]);
		value.setState("segments", (segments) => [segments[1], segments[0]]);
		expect(
			value.children().map(({ segment, index }) => [segment.name, index]),
		).toEqual([
			["second", 0],
			["first", 1],
		]);
		expect(value.counts()).toEqual({ mounts: 4, cleanups: 2 });
		value.setState("segments", (segments) => segments.slice(1));
		expect(
			value.children().map(({ segment, index }) => [segment.name, index]),
		).toEqual([["first", 0]]);
		expect(value.counts()).toEqual({ mounts: 5, cleanups: 4 });
	});

	it("makes stable indexed entries available for hovered off-time masks", () => {
		const value = fixture();
		const entry = value.indexed()[0];
		value.setTime(20);
		expect(value.visible()).toEqual([]);
		value.setTime(21);
		expect(value.indexed()[0]).toBe(entry);
		value.setState("segments", 0, "end", 30);
		expect(value.visible()[0]).toBe(entry);
	});
});

import { expect, test } from "bun:test";
import { previewDetailBase } from "./browser-local-playback";

const canvas = (width: number, height: number) => ({
	getBoundingClientRect: () => ({ width, height }) as DOMRect,
});

const presets = {
	full: [1920, 1080],
	half: [960, 540],
	quarter: [480, 270],
} as const;

function sizes(width: number, height: number, density: number) {
	return Object.fromEntries(
		Object.entries(presets).map(([name, [w, h]]) => [
			name,
			previewDetailBase(canvas(width, height), w, h, density),
		]),
	);
}

test("a smaller preview preset never renders more pixels than a larger one", () => {
	for (const [width, height, density] of [
		[228, 128, 1],
		[640, 360, 1],
		[1248, 702, 2],
		[2400, 1350, 2],
	] as const) {
		const { full, half, quarter } = sizes(width, height, density);
		expect(full.width).toBeGreaterThanOrEqual(half.width);
		expect(half.width).toBeGreaterThanOrEqual(quarter.width);
		expect(full.height).toBeGreaterThanOrEqual(half.height);
		expect(half.height).toBeGreaterThanOrEqual(quarter.height);
	}
});

test("Quarter renders a quarter of a small preview", () => {
	expect(sizes(228, 128, 1).quarter).toEqual({ width: 57, height: 32 });
});

test("Quarter never renders above its own preset on a large preview", () => {
	expect(sizes(2400, 1350, 2).quarter).toEqual({ width: 480, height: 270 });
});

test("Full and Half keep sizing to the preview's real pixels", () => {
	expect(sizes(1248, 702, 2).full).toEqual({ width: 2496, height: 1404 });
	expect(sizes(1248, 702, 2).half).toEqual({ width: 1248, height: 702 });
});

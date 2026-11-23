import { describe, expect, test } from "vitest";
import { shareRenderFps } from "./share-render";

describe("shareRenderFps", () => {
	test("matches the farm's rate for every recorded rate", () => {
		expect(
			[1, 10, 14, 15, 16, 17, 20, 24, 25, 27, 30, 50, 54, 55, 59, 60, 120].map(
				(fps) => [fps, shareRenderFps(fps)],
			),
		).toEqual([
			[1, 15],
			[10, 15],
			[14, 15],
			[15, 15],
			[16, 15],
			[17, 30],
			[20, 30],
			[24, 30],
			[25, 30],
			[27, 30],
			[30, 30],
			[50, 60],
			[54, 60],
			[55, 60],
			[59, 60],
			[60, 60],
			[120, 60],
		]);
	});

	test("follows the faster of the screen and camera", () => {
		expect(shareRenderFps(15, 30)).toBe(30);
		expect(shareRenderFps(60, 20)).toBe(60);
		expect(shareRenderFps(20, null)).toBe(30);
	});

	test("renders an unknown rate at 30 fps", () => {
		expect(shareRenderFps(null)).toBe(30);
		expect(shareRenderFps(0)).toBe(30);
		expect(shareRenderFps(Number.NaN)).toBe(30);
	});
});

import { describe, expect, test } from "bun:test";
import {
	exportBitrate,
	exportBitrateSample,
	exportSizeRangeMb,
} from "./browser-export-estimate";

const toMb = (bitrate: number, seconds: number) =>
	((bitrate + 320_000) * seconds) / (8 * 1024 * 1024);

describe("export bitrate", () => {
	test("counts frame rates above 30 at 60%", () => {
		expect(exportBitrate(1920, 1080, 30, 0.3)).toBe(18_662_400);
		expect(exportBitrate(1920, 1080, 60, 0.3)).toBe(29_859_840);
	});
});

describe("export size range", () => {
	const input = {
		width: 1920,
		height: 1080,
		fps: 30,
		bitsPerPixel: 0.3,
		durationSeconds: 100,
	};

	test("tops out just above the target bitrate without an earlier export", () => {
		const [low, high] = exportSizeRangeMb({ ...input, previous: null });
		expect(high).toBeCloseTo(toMb(18_662_400 * 1.1, 100));
		expect(low).toBeLessThan(high / 4);
	});

	test("narrows around what an earlier export of the video needed", () => {
		const previous = exportBitrateSample(
			(3_320_000 * 100) / 8,
			100,
			1920,
			1080,
			30,
			0.3,
		);
		const [low, high] = exportSizeRangeMb({ ...input, previous });
		const actual = toMb(3_000_000, 100);
		expect(low).toBeLessThan(actual);
		expect(high).toBeGreaterThan(actual);
		expect(high / low).toBeLessThan(2);
	});

	test("scales an earlier export to a larger output", () => {
		const previous = exportBitrateSample(
			(2_320_000 * 100) / 8,
			100,
			1280,
			720,
			30,
			0.3,
		);
		const [low, high] = exportSizeRangeMb({
			...input,
			width: 3840,
			height: 2160,
			previous,
		});
		expect(low).toBeGreaterThan(toMb(2_000_000, 100));
		expect(high).toBeLessThan(toMb(exportBitrate(3840, 2160, 30, 0.3), 100));
	});

	test("keeps the ceiling when the earlier export hit its target", () => {
		const previous = exportBitrateSample(
			(2_800_000 * 100) / 8,
			100,
			1920,
			1080,
			30,
			0.04,
		);
		const [, high] = exportSizeRangeMb({ ...input, previous });
		expect(high).toBeCloseTo(toMb(18_662_400 * 1.1, 100));
	});
});

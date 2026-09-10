import { describe, expect, it } from "vitest";
import { alignCrop } from "./crop-alignment";

describe("crop alignment", () => {
	it("centers a moved crop on both axes", () => {
		const result = alignCrop(
			{ x: 253, y: 197, width: 300, height: 200 },
			{ x: 800, y: 600 },
		);
		expect(result.bounds).toEqual({ x: 250, y: 200, width: 300, height: 200 });
		expect(result.guides).toEqual({ x: 400, y: 300 });
	});
	it("snaps a resize to the halfway line", () => {
		const result = alignCrop(
			{ x: 80, y: 70, width: 317, height: 180 },
			{ x: 800, y: 600 },
			{ origin: { x: 0, y: 0 }, axes: { x: true, y: false }, ratio: null },
		);
		expect(result.bounds).toEqual({ x: 80, y: 70, width: 320, height: 180 });
		expect(result.guides).toEqual({ x: 400, y: null });
	});
	it("keeps the opposite corner fixed", () => {
		const result = alignCrop(
			{ x: 197, y: 153, width: 343, height: 237 },
			{ x: 800, y: 600 },
			{ origin: { x: 1, y: 1 }, axes: { x: true, y: true }, ratio: null },
		);
		expect(result.bounds).toEqual({ x: 200, y: 150, width: 340, height: 240 });
		expect(result.guides).toEqual({ x: 200, y: 150 });
	});
	it("keeps alt resizing centered", () => {
		const result = alignCrop(
			{ x: 163, y: 85, width: 234, height: 190 },
			{ x: 800, y: 600 },
			{ origin: { x: 0.5, y: 0.5 }, axes: { x: true, y: false }, ratio: null },
		);
		expect(result.bounds).toEqual({ x: 160, y: 85, width: 240, height: 190 });
		expect(result.guides).toEqual({ x: 400, y: null });
	});
	it("preserves a locked ratio", () => {
		const result = alignCrop(
			{ x: 80, y: 70, width: 317, height: 158.5 },
			{ x: 800, y: 600 },
			{ origin: { x: 0, y: 0 }, axes: { x: true, y: true }, ratio: 2 },
		);
		expect(result.bounds).toEqual({ x: 80, y: 70, width: 320, height: 160 });
		expect(result.guides).toEqual({ x: 400, y: null });
	});
	it("releases beyond six display pixels", () => {
		const result = alignCrop(
			{ x: 263, y: 217, width: 300, height: 200 },
			{ x: 800, y: 600 },
		);
		expect(result.bounds).toEqual({ x: 263, y: 217, width: 300, height: 200 });
		expect(result.guides).toEqual({ x: null, y: null });
	});
	it("never collapses a tiny crop", () => {
		const result = alignCrop(
			{ x: 400, y: 300, width: 3, height: 3 },
			{ x: 800, y: 600 },
			{ origin: { x: 0, y: 0 }, axes: { x: true, y: true }, ratio: null },
		);
		expect(result.bounds).toEqual({ x: 400, y: 300, width: 3, height: 3 });
		expect(result.guides).toEqual({ x: null, y: null });
	});
	it("snaps to the image boundary", () => {
		const result = alignCrop(
			{ x: 3, y: 91, width: 318, height: 217 },
			{ x: 800, y: 600 },
		);
		expect(result.bounds).toEqual({ x: 0, y: 91, width: 318, height: 217 });
		expect(result.guides).toEqual({ x: 0, y: null });
	});
});

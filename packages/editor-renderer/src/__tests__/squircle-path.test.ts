import { describe, expect, it } from "vitest";
import { squirclePath } from "../squircle-path";

describe("squirclePath", () => {
	it("generates a closed path with the expected number of points", () => {
		const points = squirclePath(100, 100, 50, 50, 20);
		expect(points.length).toBe(201);
		expect(points[0].x).toBeCloseTo(points[200].x, 5);
		expect(points[0].y).toBeCloseTo(points[200].y, 5);
	});

	it("keeps all points within the bounding box", () => {
		const cx = 200;
		const cy = 150;
		const halfW = 80;
		const halfH = 60;
		const points = squirclePath(cx, cy, halfW, halfH, 30);

		for (const p of points) {
			expect(p.x).toBeGreaterThanOrEqual(cx - halfW - 0.01);
			expect(p.x).toBeLessThanOrEqual(cx + halfW + 0.01);
			expect(p.y).toBeGreaterThanOrEqual(cy - halfH - 0.01);
			expect(p.y).toBeLessThanOrEqual(cy + halfH + 0.01);
		}
	});

	it("handles zero radius producing a near-rectangular shape", () => {
		const points = squirclePath(0, 0, 50, 50, 0);
		expect(points.length).toBe(201);

		const maxX = Math.max(...points.map((p) => Math.abs(p.x)));
		const maxY = Math.max(...points.map((p) => Math.abs(p.y)));
		expect(maxX).toBeCloseTo(50, 0);
		expect(maxY).toBeCloseTo(50, 0);
	});

	it("handles max radius producing a smooth squircle shape", () => {
		const points = squirclePath(0, 0, 50, 50, 50);
		expect(points.length).toBe(201);

		const midPoint = points[Math.floor(201 / 8)];
		expect(Math.abs(midPoint.x)).toBeGreaterThan(30);
		expect(Math.abs(midPoint.y)).toBeGreaterThan(30);
	});
});

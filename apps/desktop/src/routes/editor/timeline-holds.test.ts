import { describe, expect, it } from "vitest";
import { holdWindows, totalHeldDuration } from "./timeline-holds";

const fullscreen = (start: number, end: number) => ({
	start,
	end,
	layout: "fullscreen" as const,
});

describe("holdWindows", () => {
	const texts = [
		fullscreen(1, 2),
		fullscreen(4.2, 5),
		fullscreen(6.4, 7.4),
		fullscreen(9, 9.5),
	];

	it("counts every hold without the clips' end", () => {
		expect(holdWindows(texts)).toEqual([
			[1, 2],
			[4.2, 5],
			[6.4, 7.4],
			[9, 9.5],
		]);
	});

	it("leaves out holds that start after the clips have ended", () => {
		const holds = holdWindows(texts, 3.2);
		expect(holds).toEqual([
			[1, 2],
			[4.2, 5],
		]);
		expect(3.2 + totalHeldDuration(holds)).toBeCloseTo(5);
		expect(holdWindows(texts, 2)).toEqual([[1, 2]]);
	});
});

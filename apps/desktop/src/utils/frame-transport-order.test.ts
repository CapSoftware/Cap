import { describe, expect, it } from "vitest";
import { decideFrameOrder } from "./frame-transport-order";

describe("decideFrameOrder", () => {
	it("accepts frame when candidate is missing", () => {
		const decision = decideFrameOrder(null, 120, 30);
		expect(decision).toEqual({
			action: "accept",
			nextLatestFrameNumber: 120,
			dropsIncrement: 0,
		});
	});

	it("accepts first frame and seeds latest", () => {
		const decision = decideFrameOrder(120, null, 30);
		expect(decision).toEqual({
			action: "accept",
			nextLatestFrameNumber: 120,
			dropsIncrement: 0,
		});
	});

	it("drops short backward stale frames", () => {
		const decision = decideFrameOrder(119, 120, 30);
		expect(decision).toEqual({
			action: "drop",
			nextLatestFrameNumber: 120,
			dropsIncrement: 1,
		});
	});

	it("accepts large backward jumps for seeks", () => {
		const decision = decideFrameOrder(80, 120, 30);
		expect(decision).toEqual({
			action: "accept",
			nextLatestFrameNumber: 80,
			dropsIncrement: 0,
		});
	});

	it("accepts forward progression", () => {
		const decision = decideFrameOrder(121, 120, 30);
		expect(decision).toEqual({
			action: "accept",
			nextLatestFrameNumber: 121,
			dropsIncrement: 0,
		});
	});
});

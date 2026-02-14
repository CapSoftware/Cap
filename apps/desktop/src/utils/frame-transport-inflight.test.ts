import { describe, expect, it } from "vitest";
import {
	decideWorkerInflightDispatch,
	updateWorkerInflightPeaks,
} from "./frame-transport-inflight";

describe("frame-transport-inflight", () => {
	it("dispatches when worker inflight is below limit", () => {
		expect(decideWorkerInflightDispatch(1, 2, false)).toEqual({
			action: "dispatch",
			nextWorkerFramesInFlight: 2,
			backpressureHitsIncrement: 0,
			supersededDropsIncrement: 0,
		});
	});

	it("returns backpressure without superseded increment when queue empty", () => {
		expect(decideWorkerInflightDispatch(2, 2, false)).toEqual({
			action: "backpressure",
			nextWorkerFramesInFlight: 2,
			backpressureHitsIncrement: 1,
			supersededDropsIncrement: 0,
		});
	});

	it("returns backpressure with superseded increment when queue occupied", () => {
		expect(decideWorkerInflightDispatch(4, 2, true)).toEqual({
			action: "backpressure",
			nextWorkerFramesInFlight: 4,
			backpressureHitsIncrement: 1,
			supersededDropsIncrement: 1,
		});
	});

	it("updates worker inflight peaks", () => {
		expect(updateWorkerInflightPeaks(3, 2, 5)).toEqual({
			peakWindow: 3,
			peakTotal: 5,
		});
	});
});

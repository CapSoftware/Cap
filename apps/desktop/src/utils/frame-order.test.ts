import { describe, expect, it } from "vitest";
import {
	frameNumberForwardDelta,
	isFrameNumberNewer,
	shouldDropOutOfOrderFrame,
} from "./frame-order";

describe("frame-order utilities", () => {
	it("treats positive forward deltas as newer", () => {
		expect(frameNumberForwardDelta(41, 40)).toBe(1);
		expect(isFrameNumberNewer(41, 40)).toBe(true);
	});

	it("treats wraparound forward deltas as newer", () => {
		expect(frameNumberForwardDelta(2, 0xffffffff)).toBe(3);
		expect(isFrameNumberNewer(2, 0xffffffff)).toBe(true);
	});

	it("drops duplicate frame numbers", () => {
		expect(shouldDropOutOfOrderFrame(120, 120)).toBe(true);
	});

	it("drops slightly older out-of-order frames inside stale window", () => {
		expect(shouldDropOutOfOrderFrame(119, 120, 30)).toBe(true);
		expect(shouldDropOutOfOrderFrame(90, 120, 30)).toBe(true);
	});

	it("keeps older frames beyond stale window as seek candidates", () => {
		expect(shouldDropOutOfOrderFrame(89, 120, 30)).toBe(false);
	});

	it("keeps forward frames", () => {
		expect(shouldDropOutOfOrderFrame(121, 120, 30)).toBe(false);
	});
});

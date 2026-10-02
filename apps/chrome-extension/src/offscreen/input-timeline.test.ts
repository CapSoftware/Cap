import { describe, expect, it } from "vitest";
import { InputTimeline } from "./input-timeline";

describe("tab input timeline", () => {
	it("maps delayed batches across pause and resume", () => {
		const timeline = new InputTimeline(1_000);
		expect(timeline.timeFor(1_100)).toBe(100);
		timeline.pause(1_500);
		timeline.resume(3_000);
		expect(timeline.timeFor(1_250)).toBe(250);
		expect(timeline.timeFor(2_000)).toBeNull();
		expect(timeline.timeFor(3_050)).toBe(550);
		timeline.stop(3_500);
		expect(timeline.timeFor(3_500)).toBeNull();
	});

	it("keeps consecutive active spans continuous", () => {
		const timeline = new InputTimeline(1_000);
		timeline.pause(1_500);
		timeline.resume(3_000);
		timeline.pause(3_500);
		timeline.resume(4_000);
		expect(timeline.timeFor(4_050)).toBe(1_050);
		expect(timeline.timeFor(500)).toBeNull();
	});
});

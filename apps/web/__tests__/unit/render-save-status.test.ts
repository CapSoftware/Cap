import { describe, expect, it } from "vitest";
import {
	renderStatusPollDelay,
	unansweredPollDelay,
} from "@/app/s/[videoId]/_components/render-save-status";

describe("render status polling", () => {
	it("polls quickly while a render normally reports", () => {
		expect(renderStatusPollDelay(0, false)).toBe(3000);
		expect(renderStatusPollDelay(119_000, true)).toBe(3000);
	});

	it("backs off for a render that runs on", () => {
		expect(renderStatusPollDelay(2 * 60_000, true)).toBe(6000);
		expect(renderStatusPollDelay(10 * 60_000, true)).toBe(15_000);
	});

	it("stops asking about a render that never started", () => {
		expect(renderStatusPollDelay(60 * 60_000, false)).toBeNull();
	});

	it("keeps watching a render that is still running after an hour", () => {
		expect(renderStatusPollDelay(60 * 60_000, true)).toBe(15_000);
		expect(renderStatusPollDelay(3 * 60 * 60_000, true)).toBe(15_000);
	});

	it("stops within a bounded number of requests when no render starts", () => {
		let elapsed = 0;
		let requests = 0;
		for (;;) {
			requests++;
			const delay = renderStatusPollDelay(elapsed, false);
			if (delay === null) break;
			elapsed += delay;
		}
		expect(requests).toBeLessThan(400);
	});

	it("checks rarely while the status route keeps failing, then stops", () => {
		expect(unansweredPollDelay(90 * 60_000)).toBe(60_000);
		expect(unansweredPollDelay(4 * 60 * 60_000)).toBeNull();
	});
});

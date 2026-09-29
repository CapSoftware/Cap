import { describe, expect, it } from "vitest";
import { renderStatusPollDelay } from "@/app/s/[videoId]/_components/render-save-status";

describe("render status polling", () => {
	it("polls quickly while a render normally reports", () => {
		expect(renderStatusPollDelay(0)).toBe(3000);
		expect(renderStatusPollDelay(119_000)).toBe(3000);
	});

	it("backs off for a render that runs on", () => {
		expect(renderStatusPollDelay(2 * 60_000)).toBe(6000);
		expect(renderStatusPollDelay(10 * 60_000)).toBe(15_000);
	});

	it("stops asking about a render that never ends", () => {
		expect(renderStatusPollDelay(60 * 60_000)).toBeNull();
	});

	it("makes at most a bounded number of requests in an hour", () => {
		let elapsed = 0;
		let requests = 0;
		for (;;) {
			requests++;
			const delay = renderStatusPollDelay(elapsed);
			if (delay === null) break;
			elapsed += delay;
		}
		expect(requests).toBeLessThan(400);
	});
});

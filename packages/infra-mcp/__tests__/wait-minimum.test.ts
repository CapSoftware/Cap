import { describe, expect, it } from "vitest";
import {
	DEFAULT_WAIT_TUNING,
	singleCheckBelowSeconds,
	waitFor,
} from "../src/wait";

describe("the shortest timeout that waits", () => {
	it("is 4 seconds with the shipped polling pace", () => {
		expect(singleCheckBelowSeconds(DEFAULT_WAIT_TUNING)).toBe(4);
	});

	it.each([300, 1_000, 3_000])(
		"makes exactly one check below the stated bound (poll every %i ms)",
		async (pollIntervalMs) => {
			const tuning = { ...DEFAULT_WAIT_TUNING, pollIntervalMs };
			const below = singleCheckBelowSeconds(tuning) - 1;
			let polls = 0;
			const startedAt = Date.now();
			const outcome = await waitFor({
				poll: async () => {
					polls += 1;
					return "processing";
				},
				settled: () => false,
				tuning,
				timeoutMs: below * 1000,
			});

			expect(outcome.settled).toBe(false);
			expect(polls).toBe(1);
			expect(Date.now() - startedAt).toBeLessThan(200);
		},
	);
});

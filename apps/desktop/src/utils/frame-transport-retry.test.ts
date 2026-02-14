import { describe, expect, it } from "vitest";
import { decideSabWriteFailure } from "./frame-transport-retry";

describe("frame-transport-retry", () => {
	it("falls back immediately for oversized frames", () => {
		const decision = decideSabWriteFailure(true, 0, 2);
		expect(decision).toEqual({
			action: "fallback_oversize",
			nextRetryCount: 0,
		});
	});

	it("retries while below retry limit", () => {
		const decision = decideSabWriteFailure(false, 1, 2);
		expect(decision).toEqual({
			action: "retry",
			nextRetryCount: 2,
		});
	});

	it("falls back when retry limit is reached", () => {
		const decision = decideSabWriteFailure(false, 2, 2);
		expect(decision).toEqual({
			action: "fallback_retry_limit",
			nextRetryCount: 0,
		});
	});
});

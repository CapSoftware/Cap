import { describe, expect, it } from "vitest";
import { decideStrideCorrectionDispatch } from "./frame-transport-stride";

describe("decideStrideCorrectionDispatch", () => {
	it("dispatches immediately when no request is in flight", () => {
		const decision = decideStrideCorrectionDispatch(false, false);
		expect(decision).toEqual({
			action: "dispatch",
			nextInFlight: true,
			nextHasPending: false,
			supersededDropsIncrement: 0,
			dispatchesIncrement: 1,
		});
	});

	it("queues request when worker is in flight without pending", () => {
		const decision = decideStrideCorrectionDispatch(true, false);
		expect(decision).toEqual({
			action: "queue",
			nextInFlight: true,
			nextHasPending: true,
			supersededDropsIncrement: 0,
			dispatchesIncrement: 0,
		});
	});

	it("queues and supersedes older pending request", () => {
		const decision = decideStrideCorrectionDispatch(true, true);
		expect(decision).toEqual({
			action: "queue",
			nextInFlight: true,
			nextHasPending: true,
			supersededDropsIncrement: 1,
			dispatchesIncrement: 0,
		});
	});
});

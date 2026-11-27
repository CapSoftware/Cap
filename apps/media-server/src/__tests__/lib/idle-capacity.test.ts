import { describe, expect, test } from "bun:test";
import { idleCapacityAllows } from "../../lib/job-manager";

const roomy = {
	draining: false,
	effectiveMax: 4,
	active: 1,
	cpuPressure: 0.2,
	activeHeavyLadders: 0,
	activeIdleJobs: 0,
};

describe("idleCapacityAllows", () => {
	test("admits an idle job on a worker with room to spare", () => {
		expect(idleCapacityAllows(roomy)).toBe(true);
		expect(idleCapacityAllows({ ...roomy, active: 2 })).toBe(true);
	});

	test("needs two free slots before it is admitted", () => {
		expect(idleCapacityAllows({ ...roomy, active: 3 })).toBe(false);
		expect(idleCapacityAllows({ ...roomy, effectiveMax: 1, active: 0 })).toBe(
			false,
		);
		expect(idleCapacityAllows({ ...roomy, effectiveMax: 2, active: 0 })).toBe(
			true,
		);
		expect(idleCapacityAllows({ ...roomy, effectiveMax: 0, active: 0 })).toBe(
			false,
		);
	});

	test("waits while CPU pressure is at or above half", () => {
		expect(idleCapacityAllows({ ...roomy, cpuPressure: 0.49 })).toBe(true);
		expect(idleCapacityAllows({ ...roomy, cpuPressure: 0.5 })).toBe(false);
	});

	test("waits for a heavy ladder, another idle job or a drain", () => {
		expect(idleCapacityAllows({ ...roomy, activeHeavyLadders: 1 })).toBe(false);
		expect(idleCapacityAllows({ ...roomy, activeIdleJobs: 1 })).toBe(false);
		expect(idleCapacityAllows({ ...roomy, draining: true })).toBe(false);
	});
});

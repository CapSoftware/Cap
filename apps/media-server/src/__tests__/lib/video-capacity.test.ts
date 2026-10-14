import { describe, expect, test } from "bun:test";
import { getDefaultMaxConcurrentDirectVideoProcesses } from "../../lib/video-capacity";

describe("getDefaultMaxConcurrentDirectVideoProcesses", () => {
	test("keeps one conversion on small machines", () => {
		expect(getDefaultMaxConcurrentDirectVideoProcesses(1)).toBe(1);
		expect(getDefaultMaxConcurrentDirectVideoProcesses(2)).toBe(1);
		expect(getDefaultMaxConcurrentDirectVideoProcesses(0.5)).toBe(1);
	});

	test("uses half the CPUs, capped at four", () => {
		expect(getDefaultMaxConcurrentDirectVideoProcesses(4)).toBe(2);
		expect(getDefaultMaxConcurrentDirectVideoProcesses(8)).toBe(4);
		expect(getDefaultMaxConcurrentDirectVideoProcesses(32)).toBe(4);
	});
});

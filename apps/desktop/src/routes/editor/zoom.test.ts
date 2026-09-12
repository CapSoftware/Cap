import { describe, expect, it } from "vitest";
import type { ZoomSegment } from "~/utils/tauri";
import { cloneZoomMode, splitZoomSegmentsList } from "./zoom";

describe("zoom utilities", () => {
	it("deep-clones manual zoom mode", () => {
		const manual = { manual: { x: 0.25, y: 0.75 } };
		const cloned = cloneZoomMode(manual);

		expect(cloned).toEqual(manual);
		expect(cloned).not.toBe(manual);
		if (typeof cloned === "object" && "manual" in cloned) {
			expect(cloned.manual).not.toBe(manual.manual);
		}
	});

	it("preserves auto zoom mode", () => {
		expect(cloneZoomMode("auto")).toBe("auto");
	});

	it("splits zoom segment with independent mode objects", () => {
		const segments: ZoomSegment[] = [
			{
				start: 0,
				end: 10,
				amount: 2.0,
				mode: { manual: { x: 0.2, y: 0.3 } },
			},
		];

		const success = splitZoomSegmentsList(segments, 0, 4);

		expect(success).toBe(true);
		expect(segments).toHaveLength(2);

		const [first, second] = segments;
		expect(first.start).toBe(0);
		expect(first.end).toBe(4);
		expect(second.start).toBe(4);
		expect(second.end).toBe(10);

		// Must not share the same object reference
		expect(first.mode).not.toBe(second.mode);
		if (
			typeof first.mode === "object" &&
			"manual" in first.mode &&
			typeof second.mode === "object" &&
			"manual" in second.mode
		) {
			expect(first.mode.manual).not.toBe(second.mode.manual);
			// Modifying second segment does not affect first segment
			second.mode.manual.x = 0.9;
			expect(first.mode.manual.x).toBe(0.2);
		}
	});

	it("prevents splitting when either resulting segment is shorter than 1s", () => {
		const segments: ZoomSegment[] = [
			{
				start: 0,
				end: 5,
				amount: 1.5,
				mode: "auto",
			},
		];

		// time < 1
		expect(splitZoomSegmentsList(segments, 0, 0.5)).toBe(false);
		expect(segments).toHaveLength(1);

		// remaining < 1
		expect(splitZoomSegmentsList(segments, 0, 4.5)).toBe(false);
		expect(segments).toHaveLength(1);
	});
});

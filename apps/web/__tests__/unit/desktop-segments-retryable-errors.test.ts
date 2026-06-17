import { describe, expect, it } from "vitest";
import { isRetryableDesktopSegmentsFinalizationError } from "@/lib/desktop-segments-retryable-errors";

describe("isRetryableDesktopSegmentsFinalizationError", () => {
	it("treats incomplete segment manifests as retryable", () => {
		expect(
			isRetryableDesktopSegmentsFinalizationError(
				'FatalError: Step "startDesktopSegmentsMuxJob" failed after 3 retries: Segment manifest is not marked as complete',
			),
		).toBe(true);
	});

	it("does not retry hard mux failures", () => {
		expect(
			isRetryableDesktopSegmentsFinalizationError(
				"Mux failed: invalid media data",
			),
		).toBe(false);
	});
});

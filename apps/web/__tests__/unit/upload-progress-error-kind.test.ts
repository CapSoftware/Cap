import { Video } from "@cap/web-domain";
import { describe, expect, it } from "vitest";
import { hasUnplayableRecordingSource } from "@/app/s/[videoId]/_components/upload-progress";

describe("upload progress error kinds", () => {
	it("classifies stored processing errors without exposing them", () => {
		expect(
			Video.getUploadProgressErrorKind(
				"source-incomplete: segment 4 missing at s3://bucket/key",
			),
		).toBe("source-unavailable");
		expect(
			Video.getUploadProgressErrorKind(
				'FatalError: Step "startDesktopSegmentsMuxJob" failed after 3 retries: Segment manifest is not marked as complete',
			),
		).toBe("retryable");
		expect(
			Video.getUploadProgressErrorKind(
				"ffmpeg exited with code 1: Invalid data found when processing input",
			),
		).toBeUndefined();
		expect(Video.getUploadProgressErrorKind(null)).toBeUndefined();
	});

	it("detects unplayable recording sources from the error kind", () => {
		expect(
			hasUnplayableRecordingSource({
				status: "error",
				lastUpdated: new Date(),
				errorMessage: null,
				errorKind: "source-unavailable",
				hasRawFallback: false,
			}),
		).toBe(true);
		expect(
			hasUnplayableRecordingSource({
				status: "error",
				lastUpdated: new Date(),
				errorMessage: null,
				errorKind: "retryable",
				hasRawFallback: false,
			}),
		).toBe(false);
	});
});

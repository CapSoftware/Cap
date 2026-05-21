import { describe, expect, it } from "vitest";
import {
	getRecordingCompleteIdempotentResult,
	isMaterializedDesktopRecordingSource,
	isSegmentedRecordingSource,
	RECORDING_COMPLETE_UNCLAIMABLE_PHASES,
} from "@/app/api/upload/[...route]/recording-complete-utils";

describe("recording complete utils", () => {
	it("treats active mux phases as successful idempotent finalization", () => {
		expect(
			getRecordingCompleteIdempotentResult({ phase: "processing" }),
		).toEqual({
			success: true,
			alreadyProcessing: true,
			phase: "processing",
		});
		expect(
			getRecordingCompleteIdempotentResult({
				phase: "generating_thumbnail",
			}),
		).toEqual({
			success: true,
			alreadyProcessing: true,
			phase: "generating_thumbnail",
		});
	});

	it("treats complete uploads as successful idempotent finalization", () => {
		expect(getRecordingCompleteIdempotentResult({ phase: "complete" })).toEqual(
			{
				success: true,
				alreadyComplete: true,
				phase: "complete",
			},
		);
	});

	it("does not hide claimable or failed upload phases", () => {
		expect(getRecordingCompleteIdempotentResult({ phase: "uploading" })).toBe(
			null,
		);
		expect(getRecordingCompleteIdempotentResult({ phase: "error" })).toBe(null);
		expect(getRecordingCompleteIdempotentResult(null)).toBe(null);
	});

	it("keeps active and complete phases out of the mux claim update", () => {
		expect(RECORDING_COMPLETE_UNCLAIMABLE_PHASES).toEqual([
			"processing",
			"generating_thumbnail",
			"complete",
		]);
	});

	it("recognizes segmented and already materialized desktop recordings", () => {
		expect(isSegmentedRecordingSource({ type: "desktopSegments" })).toBe(true);
		expect(isSegmentedRecordingSource({ type: "desktopMP4" })).toBe(false);
		expect(isMaterializedDesktopRecordingSource({ type: "desktopMP4" })).toBe(
			true,
		);
		expect(
			isMaterializedDesktopRecordingSource({ type: "desktopSegments" }),
		).toBe(false);
	});
});

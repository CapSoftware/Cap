import { describe, expect, it } from "vitest";
import {
	appendLocalRecordingChunk,
	finalizeLocalRecording,
	initialLocalRecordingState,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/local-recording-backup";

const makeBlob = (size: number, type = "video/webm;codecs=vp9,opus") =>
	new Blob([new Uint8Array(size)], { type });

describe("local recording backup", () => {
	it("retains a full local copy when configured for capped streaming backup", () => {
		const firstChunk = makeBlob(3);
		const secondChunk = makeBlob(4);

		const afterFirstChunk = appendLocalRecordingChunk(
			initialLocalRecordingState(),
			firstChunk,
			{ mode: "capped", maxBytes: 10 },
		);
		const afterSecondChunk = appendLocalRecordingChunk(
			afterFirstChunk,
			secondChunk,
			{ mode: "capped", maxBytes: 10 },
		);

		const blob = finalizeLocalRecording(afterSecondChunk);

		expect(afterSecondChunk.overflowed).toBe(false);
		expect(afterSecondChunk.retainedBytes).toBe(7);
		expect(blob?.size).toBe(7);
		expect(blob?.type).toBe("video/webm;codecs=vp9,opus");
	});

	it("drops the backup copy after the capped limit is exceeded", () => {
		const firstChunk = makeBlob(6);
		const secondChunk = makeBlob(5);
		const thirdChunk = makeBlob(3);

		const afterFirstChunk = appendLocalRecordingChunk(
			initialLocalRecordingState(),
			firstChunk,
			{ mode: "capped", maxBytes: 10 },
		);
		const afterSecondChunk = appendLocalRecordingChunk(
			afterFirstChunk,
			secondChunk,
			{ mode: "capped", maxBytes: 10 },
		);
		const afterThirdChunk = appendLocalRecordingChunk(
			afterSecondChunk,
			thirdChunk,
			{ mode: "capped", maxBytes: 10 },
		);

		const blob = finalizeLocalRecording(afterThirdChunk);

		expect(afterSecondChunk.overflowed).toBe(true);
		expect(afterSecondChunk.retainedBytes).toBe(0);
		expect(afterSecondChunk.chunks).toHaveLength(0);
		expect(afterThirdChunk.overflowed).toBe(true);
		expect(afterThirdChunk.retainedBytes).toBe(0);
		expect(afterThirdChunk.chunks).toHaveLength(0);
		expect(blob).toBeNull();
	});

	it("keeps the uncapped buffered fallback intact", () => {
		const state = appendLocalRecordingChunk(
			initialLocalRecordingState(),
			makeBlob(12, "video/mp4"),
			{ mode: "full" },
		);

		const blob = finalizeLocalRecording(state);

		expect(state.overflowed).toBe(false);
		expect(blob?.size).toBe(12);
		expect(blob?.type).toBe("video/mp4");
	});
});

import { describe, expect, it } from "vitest";
import { videoDetail, videoDurationSeconds, videoRow } from "../src/shape";

describe("durationSeconds on video views", () => {
	it("is the API's durationSeconds", () => {
		const video = { id: "v1", duration: 12.5, durationSeconds: 12.5 };
		expect(videoRow(video)).toMatchObject({
			duration: 12.5,
			durationSeconds: 12.5,
		});
		expect(videoDetail(video)).toMatchObject({
			duration: 12.5,
			durationSeconds: 12.5,
		});
	});

	it("falls back to duration from an API that does not send durationSeconds yet", () => {
		expect(videoDurationSeconds({ duration: 7 })).toBe(7);
		expect(videoDurationSeconds({ duration: null })).toBeNull();
		expect(videoDurationSeconds({})).toBeNull();
	});
});

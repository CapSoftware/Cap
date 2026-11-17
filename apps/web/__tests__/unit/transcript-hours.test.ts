import { describe, expect, it } from "vitest";
import { parseTranscriptVTT } from "@/app/s/[videoId]/_components/utils/parse-transcript-vtt";
import { formatTime } from "@/app/s/[videoId]/_components/utils/transcript-utils";
import { formatToWebVTT } from "@/lib/transcribe-utils";

describe("transcript timestamp labels", () => {
	it.each([
		[12_250, "00:12", 12.25, 12.75],
		[3_599_250, "59:59", 3599.25, 3599.75],
		[3_600_000, "01:00:00", 3600, 3600.5],
		[3_612_250, "01:00:12", 3612.25, 3612.75],
		[7_212_250, "02:00:12", 7212.25, 7212.75],
	] as const)(
		"keeps the complete position at %i ms",
		(start, timestamp, startTime, endTime) => {
			const vtt = formatToWebVTT({
				words: [{ text: "Reference.", start, end: start + 500 }],
			});
			expect(parseTranscriptVTT(vtt)).toEqual([
				{ id: 1, text: "Reference.", timestamp, startTime, endTime },
			]);
		},
	);
});

describe("subtitle timestamps", () => {
	it.each([
		[0, "00:00:00.000"],
		[1.001, "00:00:01.001"],
		[5.009, "00:00:05.009"],
		[59.9996, "00:01:00.000"],
		[3599.9996, "01:00:00.000"],
		[3601.001, "01:00:01.001"],
		[360000.001, "100:00:00.001"],
	])("formats %s seconds as %s", (seconds, expected) => {
		expect(formatTime(seconds)).toBe(expected);
	});
});

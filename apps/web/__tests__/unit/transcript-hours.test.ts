import { describe, expect, it } from "vitest";
import { parseTranscriptVTT } from "@/app/s/[videoId]/_components/utils/parse-transcript-vtt";
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

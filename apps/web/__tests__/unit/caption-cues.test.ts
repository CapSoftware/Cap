import { describe, expect, it } from "vitest";
import { getActiveCaptionText } from "@/app/s/[videoId]/_components/caption-cues";

function createCueList(
	cues: { startTime: number; text: string }[],
): TextTrackCueList {
	return {
		length: cues.length,
		item: (index: number) => cues[index] ?? null,
		getCueById: () => null,
	} as unknown as TextTrackCueList;
}

describe("getActiveCaptionText", () => {
	it("returns an empty caption when no cue is active", () => {
		expect(getActiveCaptionText(null)).toBe("");
		expect(getActiveCaptionText(createCueList([]))).toBe("");
	});

	it("uses the latest active cue when cues overlap", () => {
		const activeCues = createCueList([
			{ startTime: 0, text: "First caption" },
			{ startTime: 3.199, text: "<v Speaker>Second caption</v>" },
		]);

		expect(getActiveCaptionText(activeCues)).toBe("Second caption");
	});
});

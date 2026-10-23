import { describe, expect, it } from "vitest";
import { parseVTT } from "@/app/s/[videoId]/_components/utils/transcript-utils";
import { updateVttEntryText } from "@/lib/transcript-vtt";

describe("parseVTT", () => {
	it("parses standard WebVTT cues with identifier, timestamps, and text", () => {
		const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Hello world

2
00:00:03.500 --> 00:00:05.500
Second caption`;

		const entries = parseVTT(vtt);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toEqual({
			id: 1,
			timestamp: "00:01",
			startTime: 1,
			text: "Hello world",
		});
		expect(entries[1]).toEqual({
			id: 2,
			timestamp: "00:03",
			startTime: 3,
			text: "Second caption",
		});
	});

	it("preserves purely numeric caption text (e.g. '0', '007', '2026')", () => {
		const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:01.000
0

2
00:00:01.000 --> 00:00:02.000
007

3
00:00:02.000 --> 00:00:03.000
2026`;

		const entries = parseVTT(vtt);
		expect(entries).toHaveLength(3);
		expect(entries[0]).toEqual({
			id: 1,
			timestamp: "00:00",
			startTime: 0,
			text: "0",
		});
		expect(entries[1]).toEqual({
			id: 2,
			timestamp: "00:01",
			startTime: 1,
			text: "007",
		});
		expect(entries[2]).toEqual({
			id: 3,
			timestamp: "00:02",
			startTime: 2,
			text: "2026",
		});
	});

	it("preserves numeric captions edited via updateVttEntryText", () => {
		const original = `WEBVTT

1
00:00:00.000 --> 00:00:01.000
Initial caption
`;
		const saved = updateVttEntryText(original, 1, "0");
		expect(saved.updated).toBe(true);

		const entries = parseVTT(saved.content);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			id: 1,
			timestamp: "00:00",
			startTime: 0,
			text: "0",
		});
	});

	it("strips wrapping quotes from caption text", () => {
		const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:01.000
"Quoted caption"`;

		const entries = parseVTT(vtt);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.text).toBe("Quoted caption");
	});

	it("sorts entries chronologically by startTime", () => {
		const vtt = `WEBVTT

2
00:00:05.000 --> 00:00:07.000
Later caption

1
00:00:01.000 --> 00:00:03.000
Earlier caption`;

		const entries = parseVTT(vtt);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.id).toBe(1);
		expect(entries[1]?.id).toBe(2);
	});
});

import { describe, expect, it } from "vitest";
import { clock, speedLabel } from "@/components/cap-player/CapPlayer";
import { listLevels } from "@/components/cap-player/source";

describe("cap player quality levels", () => {
	it("lists renditions largest first with the index the stream uses", () => {
		const levels = listLevels([
			{ width: 640, height: 360, bitrate: 400_000 },
			{ width: 1280, height: 720, bitrate: 2_000_000 },
			{ width: 1920, height: 1080, bitrate: 4_500_000 },
			{ width: 2560, height: 1440, bitrate: 9_000_000 },
			{ width: 3840, height: 2160, bitrate: 16_000_000 },
		]);
		expect(levels.map((level) => level.label)).toEqual([
			"4K",
			"1440p",
			"1080p",
			"720p",
			"360p",
		]);
		expect(levels.map((level) => level.index)).toEqual([4, 3, 2, 1, 0]);
	});

	it("labels wide and portrait renditions by their long side", () => {
		const levels = listLevels([
			{ width: 860, height: 360, bitrate: 500_000 },
			{ width: 1920, height: 804, bitrate: 4_000_000 },
			{ width: 2160, height: 3840, bitrate: 16_000_000 },
		]);
		expect(levels.map((level) => level.label)).toEqual(["4K", "1080p", "360p"]);
	});

	it("keeps the higher bitrate when two renditions share a label", () => {
		const levels = listLevels([
			{ width: 1920, height: 1080, bitrate: 3_000_000 },
			{ width: 1920, height: 1080, bitrate: 6_000_000 },
			{ width: 1280, height: 720, bitrate: 2_000_000 },
		]);
		expect(levels).toHaveLength(2);
		expect(levels[0]).toMatchObject({ label: "1080p", index: 1 });
	});

	it("uses the rendition's own name when the stream carries one", () => {
		const levels = listLevels([
			{ width: 860, height: 360, bitrate: 680_000, uri: "360p.m3u8" },
			{ width: 1720, height: 720, bitrate: 2_440_000, uri: "720p.m3u8" },
			{
				width: 2580,
				height: 1080,
				bitrate: 4_390_000,
				uri: "https://example.com/v/1080p.m3u8?token=abc",
			},
			{ width: 3840, height: 1608, bitrate: 13_770_000, name: "2160p" },
		]);
		expect(levels.map((level) => level.label)).toEqual([
			"4K",
			"1080p",
			"720p",
			"360p",
		]);
	});

	it("ignores names that are not a resolution", () => {
		const levels = listLevels([
			{ width: 1280, height: 720, bitrate: 2_000_000, uri: "video_720.m3u8" },
			{ width: 1920, height: 1080, bitrate: 4_000_000, name: "High" },
		]);
		expect(levels.map((level) => level.label)).toEqual(["1080p", "720p"]);
	});

	it("drops renditions with no size and handles an empty stream", () => {
		expect(listLevels([{ width: 0, height: 0, bitrate: 128_000 }])).toEqual([]);
		expect(listLevels([])).toEqual([]);
	});
});

describe("cap player labels", () => {
	it.each([
		[0, "0:00"],
		[4.9, "0:04"],
		[65, "1:05"],
		[3599, "59:59"],
		[3600, "1:00:00"],
		[3725, "1:02:05"],
		[-3, "0:00"],
	])("formats %s seconds as %s", (seconds, text) => {
		expect(clock(seconds)).toBe(text);
	});

	it("formats speeds with a multiplication sign", () => {
		expect(speedLabel(1)).toBe("1×");
		expect(speedLabel(1.25)).toBe("1.25×");
	});
});

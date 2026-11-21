import { describe, expect, it } from "vitest";
import {
	connectionCallsForLadder,
	levelIndexForHeight,
	MEASURE_WINDOW_MS,
	measuredThroughput,
	parseMasterAudioUri,
	parseMasterVariants,
	parseRememberedLine,
	parseShareQuality,
	pickLadderEngine,
	pickStartRendition,
	qualityOptions,
	REMEMBERED_LINE_MAX_AGE_MS,
	type ShareLadderPlayback,
	serializeRememberedLine,
	serializeShareQuality,
	shouldStartOnLadder,
	switchesOnViewerPause,
	throughputWindowDone,
} from "@/app/s/[videoId]/_components/share-ladder-playback";

const SOURCE_BPS = 33_000_000;

const ladder: ShareLadderPlayback = {
	masterUrl: "/api/video/hls/master.m3u8",
	renditions: [
		{ name: "1080p", width: 1920, height: 1080, bandwidth: 6_000_000 },
		{ name: "720p", width: 1280, height: 720, bandwidth: 3_000_000 },
		{ name: "360p", width: 640, height: 360, bandwidth: 800_000 },
	],
	source: { width: 3840, height: 2160, bitsPerSecond: SOURCE_BPS },
	switchOnPause: false,
};

describe("quality persistence", () => {
	it("reads auto, original and a listed rendition height", () => {
		expect(parseShareQuality("auto", ladder.renditions)).toBe("auto");
		expect(parseShareQuality("original", ladder.renditions)).toBe("original");
		expect(parseShareQuality("720", ladder.renditions)).toBe(720);
	});

	it("falls back to auto for missing, unknown or malformed values", () => {
		expect(parseShareQuality(null, ladder.renditions)).toBe("auto");
		expect(parseShareQuality(undefined, ladder.renditions)).toBe("auto");
		expect(parseShareQuality("480", ladder.renditions)).toBe("auto");
		expect(parseShareQuality("720p", ladder.renditions)).toBe("auto");
		expect(parseShareQuality("{}", ladder.renditions)).toBe("auto");
		expect(parseShareQuality("720", [])).toBe("auto");
	});

	it("round trips through its stored form", () => {
		for (const quality of ["auto", "original", 1080] as const) {
			expect(
				parseShareQuality(serializeShareQuality(quality), ladder.renditions),
			).toBe(quality);
		}
	});
});

describe("quality menu entries", () => {
	it("lists Auto, the source as Original, then each rendition", () => {
		expect(qualityOptions(ladder, true)).toEqual([
			{ id: "auto", label: "Auto" },
			{ id: "original", label: "2160p" },
			{ id: "1080", label: "1080p" },
			{ id: "720", label: "720p" },
			{ id: "360", label: "360p" },
		]);
	});

	it("labels a portrait source by its short side", () => {
		expect(
			qualityOptions(
				{
					...ladder,
					source: { width: 1080, height: 1920, bitsPerSecond: SOURCE_BPS },
				},
				false,
			),
		).toEqual([
			{ id: "auto", label: "Auto" },
			{ id: "original", label: "1080p" },
		]);
	});
});

describe("connection hint", () => {
	it("calls for the ladder on save data or a slow connection type", () => {
		expect(connectionCallsForLadder({ saveData: true }, SOURCE_BPS)).toBe(true);
		for (const effectiveType of ["slow-2g", "2g", "3g"]) {
			expect(connectionCallsForLadder({ effectiveType }, SOURCE_BPS)).toBe(
				true,
			);
		}
		expect(connectionCallsForLadder({ effectiveType: "4g" }, SOURCE_BPS)).toBe(
			false,
		);
	});

	it("calls for the ladder when the downlink is under 1.5x the source", () => {
		expect(connectionCallsForLadder({ downlink: 10 }, 7_000_000)).toBe(true);
		expect(connectionCallsForLadder({ downlink: 10 }, 6_000_000)).toBe(false);
	});

	it("ignores a missing or unusable downlink", () => {
		expect(connectionCallsForLadder(undefined, SOURCE_BPS)).toBe(false);
		expect(connectionCallsForLadder({}, SOURCE_BPS)).toBe(false);
		expect(connectionCallsForLadder({ downlink: 0 }, SOURCE_BPS)).toBe(false);
		expect(connectionCallsForLadder({ downlink: Number.NaN }, SOURCE_BPS)).toBe(
			false,
		);
	});
});

describe("remembered line", () => {
	const now = 1_800_000_000_000;

	it("reads back a stored measurement", () => {
		expect(
			parseRememberedLine(serializeRememberedLine(12_345_678.4, now), now),
		).toBe(12_345_678);
	});

	it("ignores stale, future, malformed and non-positive entries", () => {
		const stale = serializeRememberedLine(
			1_000_000,
			now - REMEMBERED_LINE_MAX_AGE_MS - 1,
		);
		expect(parseRememberedLine(stale, now)).toBeNull();
		expect(
			parseRememberedLine(serializeRememberedLine(1_000_000, now + 1), now),
		).toBeNull();
		expect(parseRememberedLine("not json", now)).toBeNull();
		expect(parseRememberedLine("12", now)).toBeNull();
		expect(parseRememberedLine('{"bitsPerSecond":"1"}', now)).toBeNull();
		expect(
			parseRememberedLine(serializeRememberedLine(0, now), now),
		).toBeNull();
		expect(parseRememberedLine(null, now)).toBeNull();
	});
});

describe("starting on the ladder", () => {
	it("starts a remembered slow line on the ladder", () => {
		expect(
			shouldStartOnLadder({
				connection: undefined,
				rememberedBitsPerSecond: 40_000_000,
				sourceBitsPerSecond: SOURCE_BPS,
			}),
		).toBe(true);
		expect(
			shouldStartOnLadder({
				connection: undefined,
				rememberedBitsPerSecond: 50_000_000,
				sourceBitsPerSecond: SOURCE_BPS,
			}),
		).toBe(false);
	});

	it("starts on the MP4 with nothing known about the line", () => {
		expect(
			shouldStartOnLadder({
				connection: undefined,
				rememberedBitsPerSecond: null,
				sourceBitsPerSecond: SOURCE_BPS,
			}),
		).toBe(false);
	});

	it("never calls for the ladder without a source bitrate", () => {
		expect(
			shouldStartOnLadder({
				connection: { saveData: true },
				rememberedBitsPerSecond: 1,
				sourceBitsPerSecond: 0,
			}),
		).toBe(false);
	});
});

describe("measured throughput", () => {
	it("waits for the window to finish unless forced", () => {
		const window = { gainedSeconds: 3, elapsedMs: 2000, fullyBuffered: false };
		expect(throughputWindowDone(window)).toBe(false);
		expect(measuredThroughput(window, SOURCE_BPS)).toBeNull();
		expect(measuredThroughput(window, SOURCE_BPS, true)).toBe(
			(3 * SOURCE_BPS) / 2,
		);
	});

	it("measures the line once ten seconds are buffered ahead", () => {
		const window = { gainedSeconds: 10, elapsedMs: 500, fullyBuffered: false };
		expect(throughputWindowDone(window)).toBe(true);
		expect(measuredThroughput(window, SOURCE_BPS)).toBe(20 * SOURCE_BPS);
	});

	it("measures a slow line over the whole window", () => {
		const window = {
			gainedSeconds: 2,
			elapsedMs: MEASURE_WINDOW_MS,
			fullyBuffered: false,
		};
		expect(measuredThroughput(window, SOURCE_BPS)).toBe(0.2 * SOURCE_BPS);
	});

	it("stores nothing without real progress", () => {
		expect(
			measuredThroughput(
				{ gainedSeconds: 0, elapsedMs: 5000, fullyBuffered: false },
				SOURCE_BPS,
				true,
			),
		).toBeNull();
		expect(
			measuredThroughput(
				{ gainedSeconds: 1, elapsedMs: 200, fullyBuffered: false },
				SOURCE_BPS,
				true,
			),
		).toBeNull();
		expect(
			measuredThroughput(
				{ gainedSeconds: 4, elapsedMs: 1000, fullyBuffered: true },
				SOURCE_BPS,
			),
		).toBeNull();
	});
});

describe("playback engine", () => {
	const desktop = {
		isApple: false,
		classicMediaSource: true,
		managedMediaSource: false,
		touchPoints: 0,
		nativeHls: false,
	};

	it("uses hls.js on desktop and Android", () => {
		expect(pickLadderEngine(desktop)).toBe("hlsjs");
		expect(pickLadderEngine({ ...desktop, touchPoints: 5 })).toBe("hlsjs");
	});

	it("uses hls.js on Mac Safari with the classic MediaSource", () => {
		expect(
			pickLadderEngine({ ...desktop, isApple: true, nativeHls: true }),
		).toBe("hlsjs");
	});

	it("uses native HLS on iPhone and iPad", () => {
		expect(
			pickLadderEngine({
				isApple: true,
				classicMediaSource: false,
				managedMediaSource: true,
				touchPoints: 5,
				nativeHls: true,
			}),
		).toBe("native");
		expect(
			pickLadderEngine({
				isApple: true,
				classicMediaSource: true,
				managedMediaSource: true,
				touchPoints: 5,
				nativeHls: true,
			}),
		).toBe("native");
	});

	it("has no engine without MediaSource or native HLS", () => {
		expect(
			pickLadderEngine({ ...desktop, classicMediaSource: false }),
		).toBeNull();
	});

	it("switches at the viewer's pause only when asked and only on iPhone or iPad", () => {
		const iphone = { isApple: true, touchPoints: 5 };
		expect(switchesOnViewerPause({ switchOnPause: false }, iphone)).toBe(false);
		expect(switchesOnViewerPause({ switchOnPause: true }, iphone)).toBe(true);
		expect(
			switchesOnViewerPause(
				{ switchOnPause: true },
				{ isApple: true, touchPoints: 0 },
			),
		).toBe(false);
		expect(
			switchesOnViewerPause(
				{ switchOnPause: true },
				{ isApple: false, touchPoints: 5 },
			),
		).toBe(false);
	});
});

describe("level mapping", () => {
	it("finds an hls.js level by height whatever its order", () => {
		const levels = [
			{ width: 640, height: 360 },
			{ width: 1920, height: 1080 },
			{ width: 1280, height: 720 },
		];
		expect(levelIndexForHeight(levels, 720)).toBe(2);
		expect(levelIndexForHeight(levels, 1080)).toBe(1);
		expect(levelIndexForHeight(levels, 480)).toBe(-1);
	});

	it("starts on the smallest rendition that covers the player", () => {
		expect(
			pickStartRendition(ladder.renditions, { width: 1200, height: 675 }, null)
				?.height,
		).toBe(720);
		expect(
			pickStartRendition(ladder.renditions, { width: 2400, height: 1350 }, null)
				?.height,
		).toBe(1080);
		expect(
			pickStartRendition(ladder.renditions, { width: 320, height: 180 }, null)
				?.height,
		).toBe(360);
	});

	it("steps down to what the line carries", () => {
		expect(
			pickStartRendition(
				ladder.renditions,
				{ width: 1920, height: 1080 },
				4_000_000,
			)?.height,
		).toBe(720);
		expect(
			pickStartRendition(
				ladder.renditions,
				{ width: 1920, height: 1080 },
				100_000,
			)?.height,
		).toBe(360);
	});

	it("has no start without renditions", () => {
		expect(pickStartRendition([], { width: 1, height: 1 }, null)).toBeNull();
	});
});

describe("master playlist", () => {
	const master = [
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		"#EXT-X-INDEPENDENT-SEGMENTS",
		'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8?sig=1"',
		'#EXT-X-STREAM-INF:BANDWIDTH=6000000,AVERAGE-BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac"',
		"1080p.m3u8?sig=1",
		'#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aac"',
		"360p.m3u8?sig=1",
		"",
	].join("\r\n");

	it("lists each variant with its resolution, bandwidth and URI", () => {
		expect(parseMasterVariants(master)).toEqual([
			{
				width: 1920,
				height: 1080,
				bandwidth: 6_000_000,
				uri: "1080p.m3u8?sig=1",
			},
			{ width: 640, height: 360, bandwidth: 800_000, uri: "360p.m3u8?sig=1" },
		]);
	});

	it("finds the audio rendition", () => {
		expect(parseMasterAudioUri(master)).toBe("audio.m3u8?sig=1");
		expect(parseMasterAudioUri("#EXTM3U\n")).toBeNull();
	});
});

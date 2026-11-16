import { describe, expect, test } from "bun:test";
import {
	assertAllowedSourceUrl,
	LoomSourceRejectedError,
	parseAllowedHosts,
	Semaphore,
} from "../../loom-importer/fetch";
import {
	buildAudioOnlyArgs,
	buildRemuxArgs,
	chooseContainer,
	isAudioCopyFailure,
	resolveFps,
} from "../../loom-importer/media";
import {
	canSkipMissingSegments,
	EmptyHlsPlaylistError,
	listMediaPlaylistResources,
	parseHlsAttributes,
	selectHlsTracks,
	UnsupportedStreamError,
	withoutAudioRendition,
} from "../../loom-importer/streaming";

describe("selectHlsTracks", () => {
	const master = [
		"#EXTM3U",
		"#EXT-X-VERSION:3",
		'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="low",NAME="low",DEFAULT=YES,URI="/m/audio-low.m3u8"',
		'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="alt",DEFAULT=NO,URI="/m/audio-alt.m3u8"',
		'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="main",DEFAULT=YES,URI="/m/audio-main.m3u8"',
		'#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="avc1.4d001f,mp4a.40.2",AUDIO="low"',
		"/m/video-1500.m3u8",
		'#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=9000000,URI="/m/iframes.m3u8"',
		'#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=2400x1350,CODECS="avc1.4d002a,mp4a.40.2",AUDIO="audio"',
		"",
		"/m/video-5500.m3u8",
		'#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080,AUDIO="audio"',
		"/m/video-5500-small.m3u8",
	].join("\n");

	test("picks the highest bandwidth variant and its default audio rendition", () => {
		const selected = selectHlsTracks(master);
		expect(selected?.video).toBe("/m/video-5500.m3u8");
		expect(selected?.audio).toBe("/m/audio-main.m3u8");
		expect(selected?.masterLines).toEqual([
			"#EXTM3U",
			"#EXT-X-VERSION:3",
			'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="main",DEFAULT=YES,URI="/m/audio-main.m3u8"',
			'#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=2400x1350,CODECS="avc1.4d002a,mp4a.40.2",AUDIO="audio"',
			"/m/video-5500.m3u8",
		]);
	});

	test("keeps muxed audio when the variant has no audio group", () => {
		const selected = selectHlsTracks(
			"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=20\nhigh.m3u8",
		);
		expect(selected?.video).toBe("high.m3u8");
		expect(selected?.audio).toBeNull();
	});

	test("treats a media playlist as having no variants", () => {
		expect(
			selectHlsTracks("#EXTM3U\n#EXTINF:4,\nhttps://cdn.loom.com/a.ts"),
		).toBeNull();
	});

	test("drops the audio rendition and the variant's audio group", () => {
		const selected = selectHlsTracks(master);
		if (!selected) throw new Error("expected a selection");
		const videoOnly = withoutAudioRendition(selected);
		expect(videoOnly.video).toBe("/m/video-5500.m3u8");
		expect(videoOnly.audio).toBeNull();
		expect(videoOnly.masterLines).toEqual([
			"#EXTM3U",
			"#EXT-X-VERSION:3",
			'#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=2400x1350,CODECS="avc1.4d002a,mp4a.40.2"',
			"/m/video-5500.m3u8",
		]);
		expect(
			withoutAudioRendition({
				video: "v.m3u8",
				audio: "a.m3u8",
				masterLines: [
					'#EXT-X-STREAM-INF:AUDIO="audio",BANDWIDTH=10,CLOSED-CAPTIONS=NONE',
					"v.m3u8",
				],
			}).masterLines,
		).toEqual([
			"#EXT-X-STREAM-INF:BANDWIDTH=10,CLOSED-CAPTIONS=NONE",
			"v.m3u8",
		]);
	});

	test("parses quoted attribute values containing commas", () => {
		expect(
			parseHlsAttributes(
				'BANDWIDTH=10,CODECS="avc1.4d002a,mp4a.40.2",AUDIO="a"',
			),
		).toEqual({ BANDWIDTH: "10", CODECS: "avc1.4d002a,mp4a.40.2", AUDIO: "a" });
	});
});

describe("listMediaPlaylistResources", () => {
	test("lists the init map and every segment with their line positions", () => {
		const resources = listMediaPlaylistResources(
			[
				"#EXTM3U",
				'#EXT-X-MAP:URI="https://luna.loom.com/init.webm?Policy=x"',
				"#EXTINF:4.0,",
				"https://luna.loom.com/v-0.webm?Policy=x",
				"#EXTINF:4.0,",
				"https://luna.loom.com/v-1.webm?Policy=x",
				"#EXT-X-ENDLIST",
			].join("\n"),
		);
		expect(resources).toEqual([
			{
				url: "https://luna.loom.com/init.webm?Policy=x",
				lineIndex: 1,
				attribute: true,
			},
			{
				url: "https://luna.loom.com/v-0.webm?Policy=x",
				lineIndex: 3,
				attribute: false,
			},
			{
				url: "https://luna.loom.com/v-1.webm?Policy=x",
				lineIndex: 5,
				attribute: false,
			},
		]);
	});

	test.each([
		'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\na.ts',
		"#EXTM3U\n#EXT-X-BYTERANGE:100@0\n#EXTINF:4,\na.ts",
		'#EXTM3U\n#EXT-X-MAP:URI="i.mp4",BYTERANGE="10@0"\n#EXTINF:4,\na.ts',
		"#EXTM3U\n#EXT-X-ENDLIST",
	])("rejects playlists it cannot prefetch: %s", (playlist) => {
		expect(() => listMediaPlaylistResources(playlist)).toThrow(
			UnsupportedStreamError,
		);
	});

	test("reports a valid playlist without segments as empty", () => {
		expect(() =>
			listMediaPlaylistResources(
				[
					"#EXTM3U",
					"#EXT-X-VERSION:3",
					"#EXT-X-TARGETDURATION:0",
					"#EXT-X-MEDIA-SEQUENCE:0",
					"#EXT-X-PLAYLIST-TYPE:VOD",
					"",
					"#EXT-X-ENDLIST",
				].join("\n"),
			),
		).toThrow(EmptyHlsPlaylistError);
		expect(() =>
			listMediaPlaylistResources('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"'),
		).toThrow(EmptyHlsPlaylistError);
	});

	test("accepts an explicit unencrypted key tag", () => {
		expect(
			listMediaPlaylistResources(
				"#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.ts",
			),
		).toHaveLength(1);
	});
});

describe("assertAllowedSourceUrl", () => {
	const hosts = parseAllowedHosts(undefined);

	test.each([
		"https://luna.loom.com/id/x/playlist.m3u8?Policy=a",
		"https://cdn.loom.com/sessions/transcoded/x.mp4",
		"https://loom.com/x.ts",
	])("allows Loom hosts over https: %s", (url) => {
		expect(assertAllowedSourceUrl(url, hosts).href).toBe(url);
	});

	test.each([
		"http://luna.loom.com/a.ts",
		"https://loom.com.attacker.example/a.ts",
		"https://attackerloom.com/a.ts",
		"http://169.254.169.254/latest/meta-data/",
		"https://user:pass@luna.loom.com/a.ts",
		"file:///etc/passwd",
		"not a url",
	])("rejects anything else: %s", (url) => {
		expect(() => assertAllowedSourceUrl(url, hosts)).toThrow(
			LoomSourceRejectedError,
		);
	});

	test("allows plain http only for an exact configured host", () => {
		const local = parseAllowedHosts("127.0.0.1");
		expect(assertAllowedSourceUrl("http://127.0.0.1:9/a.ts", local).host).toBe(
			"127.0.0.1:9",
		);
		expect(() =>
			assertAllowedSourceUrl("http://localhost/a.ts", local),
		).toThrow(LoomSourceRejectedError);
	});
});

describe("media decisions", () => {
	test.each([
		[{ video: "h264", audio: "aac" }, "mp4"],
		[{ video: "h264", audio: null }, "mp4"],
		[{ video: "vp9", audio: "opus" }, "webm"],
		[{ video: "vp8", audio: "vorbis" }, "webm"],
		[{ video: "h264", audio: "opus" }, null],
		[{ video: "hevc", audio: "aac" }, null],
		[{ video: null, audio: "aac" }, null],
	] as const)("chooses a container for %o", (codecs, expected) => {
		expect(chooseContainer(codecs)).toBe(expected);
	});

	test("prefers the measured packet rate over container rates", () => {
		expect(
			resolveFps(
				{
					avg_frame_rate: "0/0",
					r_frame_rate: "1000/1",
					nb_read_packets: "600",
				},
				20,
			),
		).toBe(30);
		expect(
			resolveFps(
				{
					avg_frame_rate: "120/1",
					r_frame_rate: "120/1",
					nb_read_packets: "7749",
				},
				258.304,
			),
		).toBe(30);
	});

	test("falls back to plausible container rates", () => {
		expect(resolveFps({ r_frame_rate: "1000/1" }, 0)).toBeNull();
		expect(resolveFps({ avg_frame_rate: "30000/1001" }, 10)).toBe(29.97);
		expect(resolveFps({ avg_frame_rate: "0/0", r_frame_rate: "25/1" }, 0)).toBe(
			25,
		);
	});

	test("maps only the first video and audio stream", () => {
		const args = buildRemuxArgs([], "in.m3u8", "out.mp4", "mp4", true);
		expect(args.join(" ")).toContain("-map 0:v:0 -map 0:a:0");
		expect(args.join(" ")).toContain("-c copy -movflags +faststart -f mp4");
		expect(
			buildRemuxArgs([], "in.m3u8", "out.webm", "webm", false).join(" "),
		).not.toContain("0:a:0");
	});

	test("re-encodes only the audio when asked to", () => {
		const args = buildRemuxArgs(
			[],
			"in.m3u8",
			"out.mp4",
			"mp4",
			true,
			"encode",
		).join(" ");
		expect(args).toContain("-c:v copy -c:a aac -b:a 128k");
		expect(args).not.toContain("-c copy");
		expect(
			buildRemuxArgs([], "in.m3u8", "out.mp4", "mp4", false, "encode").join(
				" ",
			),
		).toContain("-c copy");
	});

	test("re-encodes AAC in an audio-only source when asked to", () => {
		expect(
			buildAudioOnlyArgs([], "in.m3u8", "out.mp4", "aac", 5).join(" "),
		).toContain("-c:a copy");
		expect(
			buildAudioOnlyArgs([], "in.m3u8", "out.mp4", "aac", 5, "encode").join(
				" ",
			),
		).toContain("-c:a aac -b:a 128k");
	});

	test("recognises a failed AAC stream copy", () => {
		expect(
			isAudioCopyFailure(
				new Error(
					"ffmpeg exited with code 183: [aac_adtstoasc @ 0x1] Error parsing ADTS frame header!\n[mp4 @ 0x2] Error applying bitstream filters to an output packet for stream #1: Invalid data found when processing input",
				),
			),
		).toBe(true);
		expect(
			isAudioCopyFailure(
				new Error(
					"ffmpeg exited with code 183: Error applying bitstream filters to an output packet for stream #1: Invalid data",
				),
			),
		).toBe(true);
		expect(
			isAudioCopyFailure(
				new Error(
					"ffmpeg exited with code 183: Error applying bitstream filters to an output packet for stream #0: Invalid data",
				),
			),
		).toBe(false);
		expect(isAudioCopyFailure(new Error("ffmpeg exited with code 1"))).toBe(
			false,
		);
		expect(isAudioCopyFailure("Error parsing ADTS frame header")).toBe(false);
	});
});

describe("Semaphore", () => {
	test("never runs more than its size at once", async () => {
		const semaphore = new Semaphore(3);
		let active = 0;
		let peak = 0;
		await Promise.all(
			Array.from({ length: 20 }, () =>
				semaphore.run(async () => {
					active++;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 2));
					active--;
				}),
			),
		);
		expect(peak).toBe(3);
	});

	test("releases its slot when work throws", async () => {
		const semaphore = new Semaphore(1);
		await expect(
			semaphore.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await semaphore.run(async () => "ok")).toBe("ok");
	});
});

describe("canSkipMissingSegments", () => {
	const segments = (count: number, duration: number) =>
		Array.from({ length: count }, () => duration);

	test("accepts a source with nothing missing", () => {
		expect(canSkipMissingSegments([], segments(3, 4))).toBe(true);
	});

	test("accepts one missing segment in a long recording", () => {
		expect(canSkipMissingSegments([5], segments(1183, 5))).toBe(true);
	});

	test("accepts a missing short final segment in a short recording", () => {
		expect(canSkipMissingSegments([3.07], [...segments(33, 6), 3.07])).toBe(
			true,
		);
	});

	test("rejects more missing segments than one percent allows", () => {
		expect(canSkipMissingSegments([6, 6], segments(34, 6))).toBe(false);
		expect(canSkipMissingSegments(segments(12, 5), segments(1183, 5))).toBe(
			false,
		);
	});

	test("rejects a missing segment that is too long to skip", () => {
		expect(canSkipMissingSegments([20], segments(30, 20))).toBe(false);
	});

	test("rejects losing every segment", () => {
		expect(canSkipMissingSegments([2], [2])).toBe(false);
	});
});

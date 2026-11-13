import { describe, expect, it, vi } from "vitest";
import {
	buildSlicedHlsMaster,
	HLS_AUDIO_BITRATE,
	HLS_AUDIO_NAME,
	HLS_SEGMENT_SECONDS,
	joinHlsSlicePlaylists,
	planHlsLadderSlices,
	readHlsSlicePlaylist,
} from "@/lib/developer-video-sliced-playlist";
import {
	HLS_LADDER_AUDIO_BITRATE_KBPS,
	HLS_LADDER_AUDIO_NAME,
	HLS_LADDER_SEGMENT_SECONDS,
	planHlsLadderSlices as planOnMediaServer,
	stitchHlsLadderSlices,
} from "../../../media-server/src/lib/hls-ladder";
import { slicePlaylist } from "../fixtures/developer-video-slices";

// The media server's ladder module reaches a Bun-only import through its
// input policy. Nothing here runs it.
vi.mock("bun", () => ({ spawnSync: vi.fn() }));

const read = (stream: string, slice: number, segments: number[]) =>
	readHlsSlicePlaylist(
		slicePlaylist(stream, segments),
		`${stream}.m4s`,
		`${stream}-${slice}.m4s`,
	);

describe("the copy of the media server's slice planner", () => {
	it("uses the media server's segment length and audio settings", () => {
		expect(HLS_SEGMENT_SECONDS).toBe(HLS_LADDER_SEGMENT_SECONDS);
		expect(HLS_AUDIO_BITRATE).toBe(HLS_LADDER_AUDIO_BITRATE_KBPS * 1000);
		expect(HLS_AUDIO_NAME).toBe(HLS_LADDER_AUDIO_NAME);
	});

	it("plans exactly the slices the media server plans", () => {
		const durations = [
			0, 0.5, 3.9, 4, 19.9, 20, 59, 60, 61.3, 100, 119.99, 180, 240.5, 314,
			1146.2, 1246, 3599.97, 14_380,
		];
		for (const duration of durations) {
			for (const workers of [1, 2, 3, 4]) {
				for (const minimum of [20, 60]) {
					expect(planHlsLadderSlices(duration, workers, minimum)).toEqual(
						planOnMediaServer(duration, workers, minimum),
					);
				}
			}
		}
	});
});

describe("reading a slice's playlist", () => {
	it("keeps each segment's length and byte range and renames the media file", () => {
		const playlist = read("1080p", 2, [4, 4, 1.5]);

		expect(playlist.map).toBe('#EXT-X-MAP:URI="1080p-2.m4s",BYTERANGE="800@0"');
		expect(playlist.targetDuration).toBe(4);
		expect(playlist.seconds).toBeCloseTo(9.5);
		expect(playlist.segments).toEqual([
			{
				seconds: 4,
				lines: [
					"#EXTINF:4.000000,",
					"#EXT-X-BYTERANGE:1000@800",
					"1080p-2.m4s",
				],
			},
			{
				seconds: 4,
				lines: [
					"#EXTINF:4.000000,",
					"#EXT-X-BYTERANGE:1000@1800",
					"1080p-2.m4s",
				],
			},
			{
				seconds: 1.5,
				lines: [
					"#EXTINF:1.500000,",
					"#EXT-X-BYTERANGE:1000@2800",
					"1080p-2.m4s",
				],
			},
		]);
	});

	it("refuses a playlist that names another file", () => {
		expect(() =>
			readHlsSlicePlaylist(
				slicePlaylist("720p", [4]),
				"1080p.m4s",
				"1080p-0.m4s",
			),
		).toThrow("unexpected init segment");
		expect(() =>
			readHlsSlicePlaylist(
				`${slicePlaylist("1080p", [4])}https://elsewhere.example/x.m4s\n`,
				"1080p.m4s",
				"1080p-0.m4s",
			),
		).toThrow("unexpected file");
	});

	it("refuses a playlist with nothing in it", () => {
		expect(() =>
			readHlsSlicePlaylist(
				'#EXTM3U\n#EXT-X-MAP:URI="1080p.m4s"\n',
				"1080p.m4s",
				"1080p-0.m4s",
			),
		).toThrow("no segments");
		expect(() =>
			readHlsSlicePlaylist(
				"#EXTM3U\n#EXTINF:4.0,\n1080p.m4s\n",
				"1080p.m4s",
				"1080p-0.m4s",
			),
		).toThrow("no init segment");
	});
});

describe("joining slices into one playlist", () => {
	const first = read("1080p", 0, [4, 4]);
	const second = read("1080p", 1, [4, 2.5]);

	it("lists the first slice with no end marker while more are coming", () => {
		expect(joinHlsSlicePlaylists([first], { ended: false })).toBe(
			[
				"#EXTM3U",
				"#EXT-X-VERSION:7",
				"#EXT-X-TARGETDURATION:4",
				"#EXT-X-MEDIA-SEQUENCE:0",
				"#EXT-X-PLAYLIST-TYPE:EVENT",
				"#EXT-X-INDEPENDENT-SEGMENTS",
				"#EXT-X-START:TIME-OFFSET=0",
				'#EXT-X-MAP:URI="1080p-0.m4s",BYTERANGE="800@0"',
				"#EXTINF:4.000000,",
				"#EXT-X-BYTERANGE:1000@800",
				"1080p-0.m4s",
				"#EXTINF:4.000000,",
				"#EXT-X-BYTERANGE:1000@1800",
				"1080p-0.m4s",
				"",
			].join("\n"),
		);
	});

	it("only ever adds lines as slices arrive, then the end marker", () => {
		const one = joinHlsSlicePlaylists([first], { ended: false });
		const two = joinHlsSlicePlaylists([first, second], { ended: false });
		const done = joinHlsSlicePlaylists([first, second], { ended: true });

		expect(two.startsWith(one)).toBe(true);
		expect(done).toBe(`${two}#EXT-X-ENDLIST\n`);
		expect(two.slice(one.length)).toBe(
			[
				'#EXT-X-MAP:URI="1080p-1.m4s",BYTERANGE="800@0"',
				"#EXTINF:4.000000,",
				"#EXT-X-BYTERANGE:1000@800",
				"1080p-1.m4s",
				"#EXTINF:2.500000,",
				"#EXT-X-BYTERANGE:1000@1800",
				"1080p-1.m4s",
				"",
			].join("\n"),
		);
	});

	it("cuts the audio where the video ends while slices are still coming", () => {
		const audio = readHlsSlicePlaylist(
			slicePlaylist("audio", [4.01, 4.01, 4.01, 4.01, 2]),
			"audio.m4s",
			"audio-0.m4s",
		);

		const growing = joinHlsSlicePlaylists([audio], {
			ended: false,
			untilSeconds: 8,
		});
		const whole = joinHlsSlicePlaylists([audio], { ended: true });

		expect(growing.match(/#EXTINF/g)).toHaveLength(2);
		expect(growing).not.toContain("#EXT-X-ENDLIST");
		expect(whole.match(/#EXTINF/g)).toHaveLength(5);
		expect(whole.startsWith(growing)).toBe(true);
	});

	it("lists the same segments, in the same order, as the media server's own joiner", () => {
		const slices = [
			[4, 4, 4, 4, 4],
			[4, 4, 4],
			[4, 4, 3.2],
		];
		const master = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4000000,AVERAGE-BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
			"1080p.m3u8",
			"",
		].join("\n");
		const stitched = stitchHlsLadderSlices(
			slices.map((segments) => ({
				master,
				playlists: { "1080p": slicePlaylist("1080p", segments) },
			})),
			{ hasAudio: false },
		);

		const joined = joinHlsSlicePlaylists(
			slices.map((segments, index) => read("1080p", index, segments)),
			{ ended: true },
		);

		// The two differ only in the lines that make a playlist one that grows.
		const withoutGrowth = joined
			.replace("#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-PLAYLIST-TYPE:VOD")
			.replace("#EXT-X-START:TIME-OFFSET=0\n", "");
		expect(withoutGrowth).toBe(stitched.playlists["1080p.m3u8"]);
	});
});

describe("the master playlist of a ladder made of slices", () => {
	const variants = [
		{
			name: "1080p",
			width: 1920,
			height: 1080,
			bandwidth: 4_000_000,
			averageBandwidth: 3_000_000,
			codecs: "avc1.640028",
		},
		{
			name: "360p",
			width: 640,
			height: 360,
			bandwidth: 500_000,
			averageBandwidth: 400_000,
			codecs: "avc1.64001e",
		},
	];

	it("lists every rendition with the audio group", () => {
		expect(buildSlicedHlsMaster(variants, { hasAudio: true })).toBe(
			[
				"#EXTM3U",
				"#EXT-X-VERSION:7",
				"#EXT-X-INDEPENDENT-SEGMENTS",
				'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8"',
				'#EXT-X-STREAM-INF:BANDWIDTH=4128000,AVERAGE-BANDWIDTH=3128000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
				"1080p.m3u8",
				'#EXT-X-STREAM-INF:BANDWIDTH=628000,AVERAGE-BANDWIDTH=528000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"',
				"360p.m3u8",
				"",
			].join("\n"),
		);
	});

	it("leaves audio out for a silent video", () => {
		const master = buildSlicedHlsMaster(variants, { hasAudio: false });

		expect(master).not.toContain("AUDIO");
		expect(master).toContain(
			'#EXT-X-STREAM-INF:BANDWIDTH=4000000,AVERAGE-BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
		);
	});

	it("writes the same master as the media server's own joiner", () => {
		const sliceMasterText = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4000000,AVERAGE-BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
			"1080p.m3u8",
			'#EXT-X-STREAM-INF:BANDWIDTH=500000,AVERAGE-BANDWIDTH=400000,RESOLUTION=640x360,CODECS="avc1.64001e"',
			"360p.m3u8",
			"",
		].join("\n");
		const stitched = stitchHlsLadderSlices(
			[
				{
					master: sliceMasterText,
					playlists: {
						"1080p": slicePlaylist("1080p", [4, 4]),
						"360p": slicePlaylist("360p", [4, 4]),
					},
				},
			],
			{ hasAudio: true },
		);

		expect(buildSlicedHlsMaster(variants, { hasAudio: true })).toBe(
			stitched.master,
		);
	});
});

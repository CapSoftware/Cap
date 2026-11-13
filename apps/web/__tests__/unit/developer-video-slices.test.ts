import { describe, expect, it } from "vitest";
import {
	parseDeveloperVideoSliceLadder,
	slicedHlsKeys,
	slicedHlsMediaFiles,
	slicedHlsPlaylistFiles,
	slicedHlsPlaylistText,
} from "@/lib/developer-video-sliced-ladder";
import { HLS_SEGMENT_SECONDS } from "@/lib/developer-video-sliced-playlist";
import {
	planDeveloperVideoSlices,
	playableSlices,
	SLICED_HLS,
	slicedFileName,
	slicedHlsBytes,
	slicedHlsPlayback,
	slicedHlsRenditions,
} from "@/lib/developer-video-slices";
import { processingState } from "../fixtures/developer-video";
import {
	finishedSlice,
	runningJob,
	slice,
	slicedHls,
	slicePlaylist,
	sliceResult,
} from "../fixtures/developer-video-slices";

describe("which videos are encoded in slices", () => {
	it("keeps the single job for a video under two minutes", () => {
		expect(planDeveloperVideoSlices(8)).toBeNull();
		expect(planDeveloperVideoSlices(119.9)).toBeNull();
	});

	it("keeps the single job when the length is not known", () => {
		expect(planDeveloperVideoSlices(null)).toBeNull();
		expect(planDeveloperVideoSlices(Number.NaN)).toBeNull();
		expect(planDeveloperVideoSlices(Number.POSITIVE_INFINITY)).toBeNull();
	});

	it("gives a two minute video a short first slice and one more", () => {
		expect(planDeveloperVideoSlices(120)).toEqual([
			{ startSeconds: 0, durationSeconds: 20 },
			{ startSeconds: 20 },
		]);
	});

	it("shares the rest of a five minute video between three workers", () => {
		expect(planDeveloperVideoSlices(200)).toEqual([
			{ startSeconds: 0, durationSeconds: 20 },
			{ startSeconds: 20, durationSeconds: 60 },
			{ startSeconds: 80, durationSeconds: 60 },
			{ startSeconds: 140 },
		]);
		expect(planDeveloperVideoSlices(334)).toEqual([
			{ startSeconds: 0, durationSeconds: 20 },
			{ startSeconds: 20, durationSeconds: 108 },
			{ startSeconds: 128, durationSeconds: 108 },
			{ startSeconds: 236 },
		]);
	});

	it("puts a two minute slice between the first and the thirds of a long video", () => {
		expect(planDeveloperVideoSlices(1266)).toEqual([
			{ startSeconds: 0, durationSeconds: 20 },
			{ startSeconds: 20, durationSeconds: 120 },
			{ startSeconds: 140, durationSeconds: 376 },
			{ startSeconds: 516, durationSeconds: 376 },
			{ startSeconds: 892 },
		]);
	});

	it("needs six jobs for the longest video allowed", () => {
		expect(planDeveloperVideoSlices(4 * 60 * 60)).toEqual([
			{ startSeconds: 0, durationSeconds: 20 },
			{ startSeconds: 20, durationSeconds: 120 },
			{ startSeconds: 140, durationSeconds: 840 },
			{ startSeconds: 980, durationSeconds: 4476 },
			{ startSeconds: 5456, durationSeconds: 4476 },
			{ startSeconds: 9932 },
		]);
	});

	it("always covers the whole video on segment boundaries with no gap or overlap", () => {
		for (let duration = 120; duration <= 4 * 60 * 60; duration += 37.3) {
			const ranges = planDeveloperVideoSlices(duration) ?? [];
			expect(ranges.length).toBeGreaterThanOrEqual(2);
			expect(ranges.length).toBeLessThanOrEqual(6);
			expect(ranges[0]).toEqual({
				startSeconds: 0,
				durationSeconds: SLICED_HLS.firstSliceSeconds,
			});
			for (const [index, range] of ranges.entries()) {
				expect(range.startSeconds % HLS_SEGMENT_SECONDS).toBe(0);
				const next = ranges[index + 1];
				if (next) {
					expect(Number.isInteger(range.durationSeconds)).toBe(true);
					expect(range.startSeconds + (range.durationSeconds ?? 0)).toBe(
						next.startSeconds,
					);
				} else {
					expect(range.durationSeconds).toBeUndefined();
					expect(range.startSeconds).toBeLessThan(duration);
				}
			}
		}
	});

	it("never plans a slice a viewer playing from the first one would catch up with", () => {
		for (let duration = 120; duration <= 4 * 60 * 60; duration += 61) {
			const ranges = planDeveloperVideoSlices(duration) ?? [];
			for (const range of ranges.slice(1)) {
				const length = range.durationSeconds ?? duration - range.startSeconds;
				expect(length).toBeLessThanOrEqual(
					range.startSeconds * SLICED_HLS.rampFactor + HLS_SEGMENT_SECONDS,
				);
			}
		}
	});
});

describe("where slices are stored", () => {
	it("puts the slice and the attempt in every file name", () => {
		expect(slicedFileName("1080p.m4s", 3, "tok_A-1")).toBe(
			"1080p-3-tok_A-1.m4s",
		);
		expect(slicedFileName("master.m3u8", 0, "t")).toBe("master-0-t.m3u8");
	});

	it("keeps media where a ladder's media lives and slice playlists beside it", () => {
		expect(
			slicedHlsKeys({ appId: "app-1", id: "video-1" }, "encode-1", "out"),
		).toEqual({
			hlsPrefix: "developer/app-1/video-1/encode-1/out/hls/",
			slicePrefix: "developer/app-1/video-1/encode-1/out/slices/",
		});
	});
});

describe("a slice job's report", () => {
	it("is read with its renditions largest first", () => {
		expect(
			parseDeveloperVideoSliceLadder({
				renditions: [
					{ name: "360p", width: 640, height: 360, bandwidth: 5, bytes: 7 },
					{
						name: "1080p",
						width: 1920,
						height: 1080,
						bandwidth: 40,
						averageBandwidth: 30,
						codecs: "avc1.640028",
						bytes: 50,
					},
				],
				audio: { bytes: 9 },
			}),
		).toEqual({
			renditions: [
				{
					name: "1080p",
					width: 1920,
					height: 1080,
					bandwidth: 40,
					averageBandwidth: 30,
					bytes: 50,
					codecs: "avc1.640028",
				},
				{
					name: "360p",
					width: 640,
					height: 360,
					bandwidth: 5,
					averageBandwidth: 5,
					bytes: 7,
					codecs: null,
				},
			],
			audioBytes: 9,
		});
	});

	it("is refused when it lists no renditions", () => {
		expect(parseDeveloperVideoSliceLadder({ renditions: [] })).toBeNull();
		expect(parseDeveloperVideoSliceLadder(undefined)).toBeNull();
	});
});

describe("what a viewer can be given", () => {
	const done = (exposed: boolean | null) =>
		slicedHls({
			exposed,
			slices: [
				finishedSlice(0, 20, "a", sliceResult(20)),
				finishedSlice(20, 96, "b", sliceResult(96)),
				slice(116, 96, { job: runningJob("c") }),
				finishedSlice(212, null, "d", sliceResult(88)),
			],
		});

	it("is the finished slices from the start, stopping at the first gap", () => {
		expect(playableSlices(done(true)).map((entry) => entry.job.output)).toEqual(
			["a", "b"],
		);
	});

	it("is nothing until the first slice is in", () => {
		const sliced = slicedHls({
			exposed: null,
			slices: [
				slice(0, 20, { job: runningJob("a") }),
				finishedSlice(20, 96, "b", sliceResult(96)),
			],
		});
		expect(slicedHlsPlayback(processingState({ sliced }))).toBeNull();
	});

	it("is the growing ladder while slices are encoding", () => {
		const playback = slicedHlsPlayback(processingState({ sliced: done(true) }));
		expect(playback?.slices).toHaveLength(2);
		expect(playback?.ended).toBe(false);
		expect(playback?.output).toBe("sliced-1");
	});

	it("is nothing for a video that already played from its MP4 when the first slice landed", () => {
		expect(
			slicedHlsPlayback(processingState({ sliced: done(false) })),
		).toBeNull();
	});

	it("is the stored ladder, not the slices, once the ladder is whole", () => {
		expect(
			slicedHlsPlayback(
				processingState({
					hls: { state: "complete", output: "sliced-1" },
					sliced: { ...done(true), state: "complete" },
				}),
			),
		).toBeNull();
	});

	it("keeps the finished slices while one job encodes the video instead", () => {
		const abandoned = { ...done(true), state: "abandoned" as const };
		for (const hls of [{ state: "pending" as const }, runningJob("whole")]) {
			const playback = slicedHlsPlayback(
				processingState({ hls, sliced: abandoned }),
			);
			expect(playback?.slices).toHaveLength(2);
			expect(playback?.ended).toBe(false);
		}
		expect(
			slicedHlsPlayback(
				processingState({
					hls: { state: "failed", reason: "x" },
					sliced: abandoned,
				}),
			),
		).toBeNull();
	});

	it("carries its end marker once every slice is in", () => {
		const sliced = slicedHls({
			exposed: true,
			slices: [
				finishedSlice(0, 20, "a", sliceResult(20)),
				finishedSlice(20, null, "b", sliceResult(100)),
			],
		});
		expect(slicedHlsPlayback(processingState({ sliced }))?.ended).toBe(true);
	});
});

describe("accounting for a ladder made of slices", () => {
	const sliced = slicedHls({
		exposed: true,
		hasAudio: true,
		slices: [
			finishedSlice(0, 20, "a", sliceResult(20, { audioBytes: 300 })),
			slice(20, 80, { job: runningJob("b") }),
			finishedSlice(100, null, "c", sliceResult(60, { scale: 2 })),
		],
	});

	it("counts every stored media file once, the audio with the first slice", () => {
		expect(slicedHlsBytes(sliced)).toBe(5_700 + 300 + 11_400);
	});

	it("reports each rendition's bytes summed and its bitrate averaged over time, audio included", () => {
		expect(slicedHlsRenditions(sliced)).toEqual([
			{
				name: "1080p",
				width: 1920,
				height: 1080,
				bitrate: (3_000_000 * 20 + 6_000_000 * 60) / 80 + 128_000,
				bytes: 15_000,
				codecs: "avc1.640028,mp4a.40.2",
			},
			{
				name: "360p",
				width: 640,
				height: 360,
				bitrate: (400_000 * 20 + 800_000 * 60) / 80 + 128_000,
				bytes: 2_100,
				codecs: "avc1.64001e,mp4a.40.2",
			},
		]);
	});

	it("leaves audio out of a silent video's figures", () => {
		const silent = slicedHls({
			slices: [finishedSlice(0, null, "a", sliceResult(20))],
		});
		expect(slicedHlsRenditions(silent)[0]).toMatchObject({
			bitrate: 3_000_000,
			codecs: "avc1.640028",
		});
	});
});

describe("playlists built from stored slices", () => {
	const video = { appId: "app-1", id: "video-1" };
	const slices = [
		finishedSlice(0, 8, "a", sliceResult(8, { audioBytes: 300 })),
		finishedSlice(8, null, "b", sliceResult(6)),
	];
	const stored: Record<string, string> = {
		"developer/app-1/video-1/encode-1/out/slices/1080p-0-a.m3u8": slicePlaylist(
			"1080p",
			[4, 4],
		),
		"developer/app-1/video-1/encode-1/out/slices/1080p-1-b.m3u8": slicePlaylist(
			"1080p",
			[4, 2],
		),
		"developer/app-1/video-1/encode-1/out/slices/audio-0-a.m3u8": slicePlaylist(
			"audio",
			[4.01, 4.01, 4.01, 1.9],
		),
	};
	const read = async (key: string) => stored[key] ?? null;
	const source = (count: number, ended: boolean) => ({
		video,
		encodeId: "encode-1",
		output: "out",
		slices: playableSlices(slicedHls({ slices })).slice(0, count),
		hasAudio: true,
		ended,
	});

	it("names each slice's media by the attempt that made it", async () => {
		expect(
			await slicedHlsPlaylistText(source(2, true), "1080p.m3u8", read),
		).toBe(
			[
				"#EXTM3U",
				"#EXT-X-VERSION:7",
				"#EXT-X-TARGETDURATION:4",
				"#EXT-X-MEDIA-SEQUENCE:0",
				"#EXT-X-PLAYLIST-TYPE:EVENT",
				"#EXT-X-INDEPENDENT-SEGMENTS",
				"#EXT-X-START:TIME-OFFSET=0",
				'#EXT-X-MAP:URI="1080p-0-a.m4s",BYTERANGE="800@0"',
				"#EXTINF:4.000000,",
				"#EXT-X-BYTERANGE:1000@800",
				"1080p-0-a.m4s",
				"#EXTINF:4.000000,",
				"#EXT-X-BYTERANGE:1000@1800",
				"1080p-0-a.m4s",
				'#EXT-X-MAP:URI="1080p-1-b.m4s",BYTERANGE="800@0"',
				"#EXTINF:4.000000,",
				"#EXT-X-BYTERANGE:1000@800",
				"1080p-1-b.m4s",
				"#EXTINF:2.000000,",
				"#EXT-X-BYTERANGE:1000@1800",
				"1080p-1-b.m4s",
				"#EXT-X-ENDLIST",
				"",
			].join("\n"),
		);
	});

	it("lists the audio only as far as the video reaches until all slices are in", async () => {
		const growing = await slicedHlsPlaylistText(
			source(1, false),
			"audio.m3u8",
			read,
		);
		const whole = await slicedHlsPlaylistText(
			source(2, true),
			"audio.m3u8",
			read,
		);

		expect(growing?.match(/#EXTINF/g)).toHaveLength(2);
		expect(growing).toContain('#EXT-X-MAP:URI="audio-0-a.m4s"');
		expect(growing).not.toContain("#EXT-X-ENDLIST");
		expect(whole?.match(/#EXTINF/g)).toHaveLength(4);
		expect(whole?.endsWith("#EXT-X-ENDLIST\n")).toBe(true);
		expect(whole?.startsWith(growing ?? "x")).toBe(true);
	});

	it("builds the master from the slices' results without reading storage", async () => {
		const master = await slicedHlsPlaylistText(
			source(1, false),
			"master.m3u8",
			async () => {
				throw new Error("storage was read");
			},
		);
		expect(master).toContain("1080p.m3u8");
		expect(master).toContain('URI="audio.m3u8"');
	});

	it("has no playlist for a rendition the ladder does not have", async () => {
		expect(
			await slicedHlsPlaylistText(source(2, true), "720p.m3u8", read),
		).toBeNull();
		expect(
			await slicedHlsPlaylistText(
				{ ...source(2, true), hasAudio: false },
				"audio.m3u8",
				read,
			),
		).toBeNull();
	});

	it("fails when a finished slice's playlist is missing from storage", async () => {
		await expect(
			slicedHlsPlaylistText(source(2, true), "360p.m3u8", read),
		).rejects.toThrow("no stored playlist");
	});

	it("lists the files a finished ladder keeps", () => {
		expect(slicedHlsPlaylistFiles(source(2, true))).toEqual([
			"master.m3u8",
			"1080p.m3u8",
			"360p.m3u8",
			"audio.m3u8",
		]);
		expect(slicedHlsMediaFiles(source(2, true))).toEqual([
			"1080p-0-a.m4s",
			"360p-0-a.m4s",
			"audio-0-a.m4s",
			"1080p-1-b.m4s",
			"360p-1-b.m4s",
		]);
	});
});

import { describe, expect, test } from "bun:test";
import {
	buildHlsAudioArgs,
	buildHlsLadderArgs,
	type HlsLadderArgsInput,
	hlsLadderFrameRate,
	hlsLadderSourceFps,
	hlsRenditionsAreAligned,
	parseHlsLadderMaster,
	planHlsLadder,
	planHlsLadderSlices,
	stitchHlsLadderSlices,
} from "../../lib/hls-ladder";
import type { NvencOptions } from "../../lib/nvenc-encoder";

const NVENC: NvencOptions = {
	preset: "p1",
	cqOffset: 8,
	lookahead: 0,
	spatialAq: true,
	temporalAq: false,
	gpuDecodeCodecs: ["hevc", "av1"],
};

function summary(rungs: ReturnType<typeof planHlsLadder>) {
	return rungs.map((rung) => `${rung.name}=${rung.width}x${rung.height}`);
}

describe("planHlsLadder", () => {
	test("gives a 4K source every tier", () => {
		expect(summary(planHlsLadder({ width: 3840, height: 2160 }))).toEqual([
			"2160p=3840x2160",
			"1440p=2560x1440",
			"1080p=1920x1080",
			"720p=1280x720",
			"360p=640x360",
		]);
	});

	test("never upscales and keeps the source size as the top rendition", () => {
		expect(summary(planHlsLadder({ width: 3024, height: 1964 }))).toEqual([
			"2160p=3024x1964",
			"1440p=2218x1440",
			"1080p=1662x1080",
			"720p=1108x720",
			"360p=554x360",
		]);
	});

	test("stops at the source tier for a 1080p source", () => {
		expect(summary(planHlsLadder({ width: 1920, height: 1080 }))).toEqual([
			"1080p=1920x1080",
			"720p=1280x720",
			"360p=640x360",
		]);
	});

	test("measures portrait video by its short side", () => {
		expect(summary(planHlsLadder({ width: 1080, height: 1920 }))).toEqual([
			"1080p=1080x1920",
			"720p=720x1280",
			"360p=360x640",
		]);
	});

	test("skips a tier that is nearly the same size as the source", () => {
		expect(summary(planHlsLadder({ width: 1582, height: 890 }))).toEqual([
			"1080p=1582x890",
			"360p=640x360",
		]);
	});

	test("never plans the same size twice for an ultrawide source", () => {
		for (const source of [
			{ width: 7680, height: 2160 },
			{ width: 5120, height: 1440 },
			{ width: 2160, height: 7680 },
		]) {
			const sizes = planHlsLadder(source).map(
				(rung) => `${rung.width}x${rung.height}`,
			);
			expect(new Set(sizes).size).toBe(sizes.length);
		}
		expect(planHlsLadder({ width: 7680, height: 2160 })[0]).toMatchObject({
			name: "2160p",
			width: 4096,
			height: 1152,
		});
	});

	test("labels an odd-sized source with its nearest tier", () => {
		expect(planHlsLadder({ width: 1956, height: 1100 })[0]?.name).toBe("1080p");
		expect(planHlsLadder({ width: 2312, height: 1300 })[0]?.name).toBe("1440p");
	});

	test("labels a source wider than 16:9 by its pixel count", () => {
		const film = planHlsLadder({ width: 1920, height: 804 });
		expect(summary(film)).toEqual(["1080p=1920x804", "360p=860x360"]);
		expect(film[0]?.maxBitrateKbps).toBe(4500);
		expect(
			summary(
				planHlsLadder({ width: 1920, height: 804 }, { maxTier: "1080p" }),
			),
		).toEqual(["1080p=1920x804", "360p=860x360"]);
		expect(planHlsLadder({ width: 804, height: 1920 })[0]?.name).toBe("1080p");
		expect(planHlsLadder({ width: 2560, height: 1080 })[0]?.name).toBe("1440p");
	});

	test("keeps a wide source inside the requested tier", () => {
		expect(
			summary(
				planHlsLadder({ width: 2560, height: 1080 }, { maxTier: "1080p" }),
			),
		).toEqual(["1080p=2560x1080", "720p=1706x720", "360p=854x360"]);
		expect(
			planHlsLadder({ width: 1920, height: 804 }, { maxTier: "720p" })[0],
		).toMatchObject({ name: "720p", width: 1720, height: 720 });
	});

	test("does not lower the label of a source narrower than 16:9", () => {
		expect(planHlsLadder({ width: 1080, height: 1080 })[0]?.name).toBe("1080p");
		expect(planHlsLadder({ width: 1440, height: 1080 })[0]?.name).toBe("1080p");
		expect(planHlsLadder({ width: 960, height: 720 })[0]?.name).toBe("720p");
	});

	test("keeps a tiny source as a single rendition at its own size", () => {
		expect(summary(planHlsLadder({ width: 320, height: 240 }))).toEqual([
			"360p=320x240",
		]);
	});

	test("caps the ladder at the requested tier", () => {
		expect(
			summary(
				planHlsLadder({ width: 3840, height: 2160 }, { maxTier: "1080p" }),
			),
		).toEqual(["1080p=1920x1080", "720p=1280x720", "360p=640x360"]);
	});

	test("does not raise a small source to the requested tier", () => {
		expect(
			summary(
				planHlsLadder({ width: 1280, height: 720 }, { maxTier: "2160p" }),
			),
		).toEqual(["720p=1280x720", "360p=640x360"]);
	});

	test("keeps an ultrawide source inside the encoder's size limit", () => {
		const [top] = planHlsLadder({ width: 7680, height: 2160 });
		expect(top).toMatchObject({ width: 4096, height: 1152 });
	});

	test("produces even dimensions", () => {
		for (const rung of planHlsLadder({ width: 1365, height: 767 })) {
			expect(rung.width % 2).toBe(0);
			expect(rung.height % 2).toBe(0);
		}
	});

	test("rejects a source without dimensions", () => {
		expect(() => planHlsLadder({ width: 0, height: 0 })).toThrow();
	});
});

describe("hlsLadderFrameRate", () => {
	test("keeps broadcast frame rates exact", () => {
		expect(hlsLadderFrameRate(29.97)).toBe("30000/1001");
		expect(hlsLadderFrameRate(23.976)).toBe("24000/1001");
		expect(hlsLadderFrameRate(59.94)).toBe("60000/1001");
	});

	test("keeps ordinary frame rates", () => {
		expect(hlsLadderFrameRate(30)).toBe("30");
		expect(hlsLadderFrameRate(25)).toBe("25");
		expect(hlsLadderFrameRate(60)).toBe("60");
		expect(hlsLadderFrameRate(17.3334)).toBe("17.333");
	});

	test("caps high and nonsense frame rates", () => {
		expect(hlsLadderFrameRate(120)).toBe("60");
		expect(hlsLadderFrameRate(1000)).toBe("60");
		expect(hlsLadderFrameRate(0)).toBe("30");
		expect(hlsLadderFrameRate(Number.NaN)).toBe("30");
	});
});

describe("hlsLadderSourceFps", () => {
	const grid = (openingFps: number, fastestFps: number | null) =>
		hlsLadderFrameRate(hlsLadderSourceFps(openingFps, fastestFps));

	test("keeps the probed rate of a constant frame rate source", () => {
		expect(hlsLadderSourceFps(30, 30)).toBe(30);
		expect(hlsLadderSourceFps(60, 60)).toBe(60);
		expect(hlsLadderSourceFps(17.33, 17.33)).toBe(17.33);
		expect(grid(29.97, 29.97)).toBe("30000/1001");
		expect(grid(23.98, 23.98)).toBe("24000/1001");
		expect(grid(120, 120)).toBe("60");
	});

	test("keeps the probed rate of a recording with millisecond timestamps", () => {
		expect(hlsLadderSourceFps(30, 30.08)).toBe(30);
		expect(hlsLadderSourceFps(29.97, 30.08)).toBe(29.97);
	});

	test("keeps the probed rate when capture jitter makes a stretch look faster", () => {
		expect(hlsLadderSourceFps(29.95, 31.01)).toBe(29.95);
		expect(hlsLadderSourceFps(24.96, 25.97)).toBe(24.96);
	});

	test("keeps the probed rate when the opening is the fastest part", () => {
		expect(hlsLadderSourceFps(60, 30)).toBe(60);
	});

	test("follows the fastest stretch of a source that starts slowly", () => {
		expect(grid(5.29, 30)).toBe("30");
		expect(grid(12.03, 30.19)).toBe("30");
		expect(grid(34.29, 60)).toBe("60");
		expect(grid(7.03, 25.6)).toBe("25");
		expect(grid(5, 29.97)).toBe("30000/1001");
		expect(grid(5, 59.94)).toBe("60000/1001");
	});

	test("never picks a rate slower than the fastest stretch needs", () => {
		expect(grid(10, 38.8)).toBe("38.8");
		expect(grid(10, 47.5)).toBe("47.5");
		expect(grid(20.05, 125)).toBe("60");
	});

	test("uses the probed rate when the frames could not be timed", () => {
		expect(hlsLadderSourceFps(30, null)).toBe(30);
		expect(hlsLadderSourceFps(30, Number.NaN)).toBe(30);
		expect(grid(0, null)).toBe("30");
	});

	test("uses the fastest stretch when the probe has no rate", () => {
		expect(grid(0, 24)).toBe("24");
		expect(grid(Number.NaN, 30)).toBe("30");
	});
});

function argsInput(overrides: Partial<HlsLadderArgsInput> = {}) {
	return {
		inputPath: "/tmp/in.mp4",
		outputDir: "/tmp/out",
		videoCodec: "h264",
		hasAudio: true,
		sourceFps: 30,
		rungs: planHlsLadder({ width: 1920, height: 1080 }),
		decodeThreads: "0",
		...overrides,
	};
}

function valueAfter(args: string[], flag: string) {
	return args[args.indexOf(flag) + 1];
}

describe("buildHlsLadderArgs", () => {
	test("encodes every rendition on the GPU from one upload", () => {
		const args = buildHlsLadderArgs(
			argsInput({ nvenc: { options: NVENC, gpuDecode: false } }),
		);
		expect(valueAfter(args, "-filter_complex")).toBe(
			"[0:v]fps=30,format=nv12,hwupload_cuda,split=3[s0][s1][s2];" +
				"[s0]scale_cuda=1920:1080:format=nv12[v0];" +
				"[s1]scale_cuda=1280:720:format=nv12[v1];" +
				"[s2]scale_cuda=640:360:format=nv12[v2]",
		);
		expect(valueAfter(args, "-c:v")).toBe("h264_nvenc");
		expect(valueAfter(args, "-maxrate:v:0")).toBe("4500k");
		expect(valueAfter(args, "-bufsize:v:2")).toBe("1400k");
		expect(args).not.toContain("-hwaccel");
	});

	test("keeps frames on the GPU when the source decodes there", () => {
		const args = buildHlsLadderArgs(
			argsInput({
				videoCodec: "hevc",
				nvenc: { options: NVENC, gpuDecode: true },
			}),
		);
		expect(valueAfter(args, "-hwaccel")).toBe("cuda");
		expect(args.indexOf("hevc_cuvid")).toBeLessThan(args.indexOf("-i"));
		expect(valueAfter(args, "-filter_complex")).toStartWith(
			"[0:v]fps=30,split=3[s0][s1][s2];",
		);
	});

	test("converts an HDR source to standard range before anything is scaled", () => {
		const toSdr =
			"zscale=w=1920:h=1080:tin=arib-std-b67:pin=bt2020:min=bt2020nc:t=linear:npl=203," +
			"format=gbrpf32le,zscale=p=bt709," +
			"tonemap=tonemap=mobius:param=0.3:peak=4.93:desat=0," +
			"zscale=t=bt709:m=bt709:r=tv,format=yuv420p,";
		const onGpu = buildHlsLadderArgs(
			argsInput({
				videoCodec: "hevc",
				hdr: "arib-std-b67",
				nvenc: { options: NVENC, gpuDecode: true },
			}),
		);
		expect(valueAfter(onGpu, "-filter_complex")).toBe(
			`[0:v]fps=30,${toSdr}format=nv12,hwupload_cuda,split=3[s0][s1][s2];` +
				"[s0]scale_cuda=1920:1080:format=nv12[v0];" +
				"[s1]scale_cuda=1280:720:format=nv12[v1];" +
				"[s2]scale_cuda=640:360:format=nv12[v2]",
		);
		expect(onGpu).not.toContain("-hwaccel");
		expect(onGpu).not.toContain("hevc_cuvid");
		expect(valueAfter(onGpu, "-color_trc")).toBe("bt709");
		expect(valueAfter(onGpu, "-color_primaries")).toBe("bt709");
		expect(valueAfter(onGpu, "-colorspace")).toBe("bt709");

		const onCpu = buildHlsLadderArgs(
			argsInput({ videoCodec: "hevc", hdr: "smpte2084" }),
		);
		expect(valueAfter(onCpu, "-filter_complex")).toStartWith(
			`[0:v]fps=30,${toSdr.replace("arib-std-b67", "smpte2084")}split=3[s0][s1][s2];`,
		);
		expect(valueAfter(onCpu, "-color_trc")).toBe("bt709");
	});

	test("converts an HDR slice after it is trimmed", () => {
		const args = buildHlsLadderArgs(
			argsInput({
				videoCodec: "hevc",
				hasAudio: false,
				hdr: "smpte2084",
				range: { startSeconds: 4, durationSeconds: 4 },
				nvenc: { options: NVENC, gpuDecode: false },
			}),
		);
		expect(valueAfter(args, "-filter_complex")).toStartWith(
			"[0:v]fps=30,trim=start=4:end=8,zscale=w=1920:h=1080:tin=smpte2084:",
		);
	});

	test("converts an HDR source from the colours it declares", () => {
		const filter = (hdrColor: HlsLadderArgsInput["hdrColor"]) =>
			valueAfter(
				buildHlsLadderArgs(
					argsInput({ videoCodec: "hevc", hdr: "arib-std-b67", hdrColor }),
				),
				"-filter_complex",
			);
		const head = (primaries: string, matrix: string) =>
			`[0:v]fps=30,zscale=w=1920:h=1080:tin=arib-std-b67:pin=${primaries}:min=${matrix}:t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,`;
		expect(filter({ primaries: "bt709", matrix: "bt709" })).toStartWith(
			head("bt709", "bt709"),
		);
		expect(filter({ primaries: "smpte432", matrix: "bt2020nc" })).toStartWith(
			head("smpte432", "bt2020nc"),
		);
		expect(filter({ primaries: "bt2020", matrix: "ictcp" })).toStartWith(
			head("bt2020", "ictcp"),
		);
	});

	test("treats missing or unusable HDR colour tags as BT.2020", () => {
		const filter = (hdrColor: HlsLadderArgsInput["hdrColor"]) =>
			valueAfter(
				buildHlsLadderArgs(
					argsInput({ videoCodec: "hevc", hdr: "smpte2084", hdrColor }),
				),
				"-filter_complex",
			);
		const tagged = filter({ primaries: "bt2020", matrix: "bt2020nc" });
		expect(tagged).toContain(
			"zscale=w=1920:h=1080:tin=smpte2084:pin=bt2020:min=bt2020nc:t=linear:npl=203,",
		);
		expect(filter(undefined)).toBe(tagged);
		expect(filter(null)).toBe(tagged);
		expect(filter({ primaries: "bt2020", matrix: null })).toBe(tagged);
		expect(filter({ primaries: "bt2020", matrix: "smpte2085" })).toBe(tagged);

		const untagged = filter({ primaries: null, matrix: null });
		expect(untagged).toContain(
			"zscale=w=1920:h=1080:tin=smpte2084:pin=bt2020:p=bt2020:min=bt2020nc:t=linear:npl=203,",
		);
		expect(untagged.replace(":p=bt2020", "")).toBe(tagged);
		expect(filter({})).toBe(untagged);
		expect(filter({ primaries: "unknown", matrix: "unknown" })).toBe(untagged);
		expect(filter({ primaries: "reserved", matrix: "bt2020nc" })).toBe(
			untagged,
		);
	});

	test("ignores declared colours on a standard range source", () => {
		expect(
			buildHlsLadderArgs(
				argsInput({ hdrColor: { primaries: "bt709", matrix: "bt709" } }),
			),
		).toEqual(buildHlsLadderArgs(argsInput()));
	});

	test("leaves a standard range source exactly as it was", () => {
		for (const nvenc of [
			null,
			{ options: NVENC, gpuDecode: false },
			{ options: NVENC, gpuDecode: true },
		]) {
			const args = buildHlsLadderArgs(argsInput({ videoCodec: "hevc", nvenc }));
			expect(
				buildHlsLadderArgs(argsInput({ videoCodec: "hevc", nvenc, hdr: null })),
			).toEqual(args);
			expect(args.join(" ")).not.toContain("zscale");
			expect(args).not.toContain("-color_trc");
		}
	});

	test("falls back to software encoding without a GPU", () => {
		const args = buildHlsLadderArgs(argsInput());
		expect(valueAfter(args, "-c:v")).toBe("libx264");
		expect(valueAfter(args, "-sc_threshold")).toBe("0");
		expect(valueAfter(args, "-filter_complex")).toContain(
			"[s1]scale=1280:720:flags=lanczos,format=yuv420p[v1]",
		);
	});

	test("forces keyframes from the clock so renditions stay switchable", () => {
		for (const nvenc of [null, { options: NVENC, gpuDecode: false }]) {
			const args = buildHlsLadderArgs(argsInput({ nvenc }));
			expect(valueAfter(args, "-force_key_frames")).toBe(
				"expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+2))",
			);
			expect(valueAfter(args, "-hls_time")).toBe("4");
			expect(valueAfter(args, "-bf")).toBe("0");
		}
	});

	test("shares one audio rendition between every video rendition", () => {
		const args = buildHlsLadderArgs(argsInput());
		expect(valueAfter(args, "-var_stream_map")).toBe(
			"v:0,agroup:aud,name:1080p v:1,agroup:aud,name:720p " +
				"v:2,agroup:aud,name:360p a:0,agroup:aud,name:audio,default:yes",
		);
		expect(args.filter((arg) => arg === "0:a:0")).toHaveLength(1);
	});

	test("omits audio for a silent source", () => {
		const args = buildHlsLadderArgs(argsInput({ hasAudio: false }));
		expect(valueAfter(args, "-var_stream_map")).toBe(
			"v:0,name:1080p v:1,name:720p v:2,name:360p",
		);
		expect(args).not.toContain("aac");
	});

	test("writes one fragmented MP4 per rendition", () => {
		const args = buildHlsLadderArgs(argsInput());
		expect(valueAfter(args, "-hls_flags")).toBe(
			"independent_segments+single_file",
		);
		expect(valueAfter(args, "-hls_segment_type")).toBe("fmp4");
		expect(args.at(-1)).toBe("/tmp/out/%v.m3u8");
	});

	test("puts every rendition on one fixed frame grid", () => {
		const args = buildHlsLadderArgs(argsInput({ sourceFps: 120 }));
		expect(valueAfter(args, "-filter_complex")).toStartWith(
			"[0:v]fps=60,split=3",
		);
		expect(valueAfter(args, "-fps_mode:v")).toBe("passthrough");
	});

	test("cuts a middle slice on the shared frame grid at both ends", () => {
		const args = buildHlsLadderArgs(
			argsInput({
				hasAudio: false,
				range: { startSeconds: 112, durationSeconds: 112 },
			}),
		);
		const input = args.indexOf("-i");
		expect(args.slice(input - 6, input)).toEqual([
			"-ss",
			"110",
			"-t",
			"116",
			"-copyts",
			"-start_at_zero",
		]);
		expect(valueAfter(args, "-filter_complex")).toStartWith(
			"[0:v]fps=30,trim=start=112:end=224,split=3",
		);
		expect(valueAfter(args, "-hls_segment_options")).toBe(
			"movflags=+frag_discont",
		);
	});

	test("keeps the frames before a slice's seek point for the grid to hold", () => {
		const slice = buildHlsLadderArgs(
			argsInput({
				hasAudio: false,
				range: { startSeconds: 112, durationSeconds: 112 },
			}),
		);
		expect(slice.indexOf("-noaccurate_seek")).toBe(slice.indexOf("-ss") - 1);
		expect(slice.indexOf("-ss")).toBeLessThan(slice.indexOf("-i"));
		expect(buildHlsLadderArgs(argsInput())).not.toContain("-noaccurate_seek");
	});

	test("starts the first slice at the beginning of the source", () => {
		const args = buildHlsLadderArgs(
			argsInput({
				hasAudio: false,
				range: { startSeconds: 0, durationSeconds: 112 },
			}),
		);
		expect(valueAfter(args, "-ss")).toBe("0");
		expect(valueAfter(args, "-t")).toBe("114");
		expect(valueAfter(args, "-filter_complex")).toStartWith(
			"[0:v]fps=30,trim=end=112,split=3",
		);
	});

	test("lets the last slice run to the end of the source", () => {
		const args = buildHlsLadderArgs(
			argsInput({ hasAudio: false, range: { startSeconds: 224 } }),
		);
		expect(args).not.toContain("-t");
		expect(valueAfter(args, "-filter_complex")).toStartWith(
			"[0:v]fps=30,trim=start=224,split=3",
		);
	});

	test("leaves a whole encode on its own timeline", () => {
		const args = buildHlsLadderArgs(argsInput());
		expect(args).not.toContain("-copyts");
		expect(args).not.toContain("-hls_segment_options");
		expect(valueAfter(args, "-filter_complex")).not.toContain("trim");
	});

	test("refuses an empty ladder", () => {
		expect(() => buildHlsLadderArgs(argsInput({ rungs: [] }))).toThrow();
	});
});

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_3",DEFAULT=YES,CHANNELS="2",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1409510,AVERAGE-BANDWIDTH=723598,RESOLUTION=1662x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_aud"
1080p.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=841322,AVERAGE-BANDWIDTH=436283,RESOLUTION=1108x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_aud"
720p.m3u8
`;

describe("parseHlsLadderMaster", () => {
	test("reads each rendition and the shared audio", () => {
		const parsed = parseHlsLadderMaster(MASTER);
		expect(parsed.video).toEqual([
			{
				name: "1080p",
				playlist: "1080p.m3u8",
				media: "1080p.m4s",
				width: 1662,
				height: 1080,
				bandwidth: 1409510,
				averageBandwidth: 723598,
				codecs: "avc1.640028,mp4a.40.2",
			},
			{
				name: "720p",
				playlist: "720p.m3u8",
				media: "720p.m4s",
				width: 1108,
				height: 720,
				bandwidth: 841322,
				averageBandwidth: 436283,
				codecs: "avc1.64001f,mp4a.40.2",
			},
		]);
		expect(parsed.audio).toMatchObject({
			name: "audio",
			playlist: "audio.m3u8",
			media: "audio.m4s",
		});
	});

	test("rejects a playlist without variants", () => {
		expect(() => parseHlsLadderMaster("#EXTM3U\n")).toThrow();
	});

	test("rejects a variant that points outside the output directory", () => {
		expect(() =>
			parseHlsLadderMaster(
				"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n../other/1080p.m3u8\n",
			),
		).toThrow();
	});
});

describe("hlsRenditionsAreAligned", () => {
	const playlist = (durations: number[]) =>
		durations.map((duration) => `#EXTINF:${duration},\nx.m4s`).join("\n");

	test("accepts renditions cut at the same times", () => {
		expect(
			hlsRenditionsAreAligned([
				playlist([4.004, 4.004, 2.5]),
				playlist([4.004, 4.004, 2.5]),
			]),
		).toBe(true);
	});

	test("rejects renditions with different segment boundaries", () => {
		expect(
			hlsRenditionsAreAligned([playlist([4.004, 4.004]), playlist([4.004, 6])]),
		).toBe(false);
		expect(
			hlsRenditionsAreAligned([playlist([4.004, 4.004]), playlist([4.004])]),
		).toBe(false);
	});

	test("rejects an empty playlist", () => {
		expect(hlsRenditionsAreAligned([""])).toBe(false);
	});
});

describe("buildHlsAudioArgs", () => {
	test("encodes the whole audio track once for a sliced job", () => {
		const args = buildHlsAudioArgs({
			inputPath: "/tmp/in.mp4",
			outputDir: "/tmp/out",
		});
		expect(args).toContain("-vn");
		expect(args).toContain("-copyts");
		expect(args).toContain("-start_at_zero");
		expect(valueAfter(args, "-hls_segment_options")).toBe(
			"movflags=+frag_discont",
		);
		expect(args.at(-1)).toBe("/tmp/out/audio.m3u8");
	});
});

describe("planHlsLadderSlices", () => {
	test("splits a recording evenly across the workers on segment boundaries", () => {
		expect(planHlsLadderSlices(334.5, 3)).toEqual([
			{ startSeconds: 0, durationSeconds: 112 },
			{ startSeconds: 112, durationSeconds: 112 },
			{ startSeconds: 224 },
		]);
	});

	test("keeps a short recording on one worker", () => {
		expect(planHlsLadderSlices(30, 3)).toEqual([{ startSeconds: 0 }]);
	});

	test("uses fewer workers when slices would be too short", () => {
		expect(planHlsLadderSlices(50, 3)).toEqual([
			{ startSeconds: 0, durationSeconds: 28 },
			{ startSeconds: 28 },
		]);
	});

	test("never returns a slice that starts past the end", () => {
		for (const duration of [20, 41, 61, 119.9, 3600.2]) {
			const slices = planHlsLadderSlices(duration, 3);
			expect(slices.at(-1)?.durationSeconds).toBeUndefined();
			for (const slice of slices) {
				expect(slice.startSeconds).toBeLessThan(duration);
				expect(slice.startSeconds % 4).toBe(0);
			}
		}
	});

	test("handles an unknown duration", () => {
		expect(planHlsLadderSlices(0, 3)).toEqual([{ startSeconds: 0 }]);
	});
});

function sliceMaster(bandwidth: number, average: number) {
	return [
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${average},RESOLUTION=1920x1080,CODECS="avc1.640028"`,
		"1080p.m3u8",
		`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth / 2},AVERAGE-BANDWIDTH=${average / 2},RESOLUTION=1280x720,CODECS="avc1.64001f"`,
		"720p.m3u8",
		"",
	].join("\n");
}

function slicePlaylist(name: string, durations: number[]) {
	let offset = 800;
	const segments = durations.flatMap((duration) => {
		const lines = [
			`#EXTINF:${duration.toFixed(6)},`,
			`#EXT-X-BYTERANGE:1000@${offset}`,
			`${name}.m4s`,
		];
		offset += 1000;
		return lines;
	});
	return [
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		"#EXT-X-TARGETDURATION:4",
		"#EXT-X-MEDIA-SEQUENCE:0",
		"#EXT-X-PLAYLIST-TYPE:VOD",
		"#EXT-X-INDEPENDENT-SEGMENTS",
		`#EXT-X-MAP:URI="${name}.m4s",BYTERANGE="800@0"`,
		...segments,
		"#EXT-X-ENDLIST",
		"",
	].join("\n");
}

function slice(bandwidth: number, average: number, durations: number[]) {
	return {
		master: sliceMaster(bandwidth, average),
		playlists: {
			"1080p": slicePlaylist("1080p", durations),
			"720p": slicePlaylist("720p", durations),
		},
	};
}

describe("stitchHlsLadderSlices", () => {
	const slices = [
		slice(4_000_000, 2_000_000, [4, 4]),
		slice(6_000_000, 3_000_000, [4, 4]),
		slice(2_000_000, 1_000_000, [4, 2]),
	];

	test("lists every slice's file in order without rewriting media", () => {
		const stitched = stitchHlsLadderSlices(slices, { hasAudio: true });
		const playlist = stitched.playlists["1080p.m3u8"] ?? "";
		const uris = playlist.split("\n").filter((line) => line.endsWith(".m4s"));
		expect(uris).toEqual([
			"1080p-0.m4s",
			"1080p-0.m4s",
			"1080p-1.m4s",
			"1080p-1.m4s",
			"1080p-2.m4s",
			"1080p-2.m4s",
		]);
		expect(playlist.match(/#EXT-X-MAP:/g)).toHaveLength(3);
		expect(playlist).toContain(
			'#EXT-X-MAP:URI="1080p-1.m4s",BYTERANGE="800@0"',
		);
		expect(playlist.match(/#EXT-X-ENDLIST/g)).toHaveLength(1);
		expect(playlist.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
		expect(stitched.media).toContainEqual({
			slice: 2,
			source: "720p.m4s",
			name: "720p-2.m4s",
		});
		expect(stitched.media).toHaveLength(6);
	});

	test("advertises the peak and the time-weighted average bitrate with audio", () => {
		const stitched = stitchHlsLadderSlices(slices, { hasAudio: true });
		expect(stitched.master).toContain(
			'#EXT-X-STREAM-INF:BANDWIDTH=6128000,AVERAGE-BANDWIDTH=2218909,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
		);
		expect(stitched.master).toContain('URI="audio.m3u8"');
	});

	test("leaves audio out of a silent ladder", () => {
		const stitched = stitchHlsLadderSlices(slices, { hasAudio: false });
		expect(stitched.master).not.toContain("EXT-X-MEDIA");
		expect(stitched.master).toContain(
			'#EXT-X-STREAM-INF:BANDWIDTH=6000000,AVERAGE-BANDWIDTH=2090909,RESOLUTION=1920x1080,CODECS="avc1.640028"\n1080p.m3u8',
		);
	});

	test("round-trips through the master playlist parser", () => {
		const stitched = stitchHlsLadderSlices(slices, { hasAudio: true });
		const parsed = parseHlsLadderMaster(stitched.master);
		expect(parsed.video.map((variant) => variant.name)).toEqual([
			"1080p",
			"720p",
		]);
		expect(parsed.audio?.playlist).toBe("audio.m3u8");
	});

	test("rejects slices whose renditions were cut at different times", () => {
		const uneven = slice(1, 1, [4, 4]);
		uneven.playlists["720p"] = slicePlaylist("720p", [4, 3]);
		expect(() =>
			stitchHlsLadderSlices([uneven], { hasAudio: false }),
		).toThrow();
	});

	test("rejects a slice that is missing a rendition", () => {
		const missing = slice(1, 1, [4]);
		delete (missing.playlists as Record<string, string>)["720p"];
		expect(() =>
			stitchHlsLadderSlices([slices[0] ?? missing, missing], {
				hasAudio: false,
			}),
		).toThrow();
	});

	test("rejects a slice playlist that points at another file", () => {
		const foreign = slice(1, 1, [4]);
		foreign.playlists["1080p"] = slicePlaylist("1080p", [4]).replace(
			/1080p\.m4s$/m,
			"https://example.com/x.m4s",
		);
		expect(() =>
			stitchHlsLadderSlices([foreign], { hasAudio: false }),
		).toThrow();
	});

	test("rejects an empty job", () => {
		expect(() => stitchHlsLadderSlices([], { hasAudio: false })).toThrow();
	});
});

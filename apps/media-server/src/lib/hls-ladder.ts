import {
	type HdrColor,
	type HdrTransfer,
	hdrToSdrFilter,
	SDR_COLOR_ARGS,
} from "./hdr";
import { NVENC_HWACCEL_INPUT_ARGS, type NvencOptions } from "./nvenc-encoder";

export const HLS_LADDER_MASTER_PLAYLIST = "master.m3u8";
export const HLS_LADDER_AUDIO_NAME = "audio";
export const HLS_LADDER_SEGMENT_SECONDS = 4;
export const HLS_LADDER_KEYFRAME_SECONDS = 2;
export const HLS_LADDER_AUDIO_BITRATE_KBPS = 128;

const MAX_ENCODE_DIMENSION = 4096;
const MAX_LADDER_FPS = 60;
const NVENC_LADDER_CQ = 30;
const X264_LADDER_CRF = 23;
const AUDIO_GROUP = "aud";

export const HLS_LADDER_TIERS = [
	{ name: "2160p", shortSide: 2160, maxBitrateKbps: 14000 },
	{ name: "1440p", shortSide: 1440, maxBitrateKbps: 8000 },
	{ name: "1080p", shortSide: 1080, maxBitrateKbps: 4500 },
	{ name: "720p", shortSide: 720, maxBitrateKbps: 2500 },
	{ name: "360p", shortSide: 360, maxBitrateKbps: 700 },
] as const;

export type HlsLadderTierName = (typeof HLS_LADDER_TIERS)[number]["name"];

export const HLS_LADDER_TIER_NAMES = HLS_LADDER_TIERS.map(
	(tier) => tier.name,
) as [HlsLadderTierName, ...HlsLadderTierName[]];

export interface HlsLadderRung {
	name: HlsLadderTierName;
	width: number;
	height: number;
	maxBitrateKbps: number;
}

export interface HlsLadderSource {
	width: number;
	height: number;
}

function even(value: number): number {
	return Math.max(2, Math.round(value / 2) * 2);
}

function fitShortSide(
	size: { width: number; height: number },
	shortSide: number,
): { width: number; height: number } {
	const sourceShort = Math.min(size.width, size.height);
	const sourceLong = Math.max(size.width, size.height);
	const scale = Math.min(
		1,
		shortSide / sourceShort,
		MAX_ENCODE_DIMENSION / sourceLong,
	);
	return {
		width: even(size.width * scale),
		height: even(size.height * scale),
	};
}

function tierIndexForShortSide(shortSide: number): number {
	for (let index = 0; index < HLS_LADDER_TIERS.length - 1; index++) {
		const upper = HLS_LADDER_TIERS[index];
		const lower = HLS_LADDER_TIERS[index + 1];
		if (
			upper &&
			lower &&
			shortSide >= Math.sqrt(upper.shortSide * lower.shortSide)
		) {
			return index;
		}
	}
	return HLS_LADDER_TIERS.length - 1;
}

const WIDESCREEN = 16 / 9;

// A source wider than 16:9 has more pixels than its short side suggests:
// 1920x804 is as large as a 1080p frame cropped, not a 720p one. Tiers meet at
// the same point as tierIndexForShortSide for a 16:9 frame.
function tierIndexForPixels(pixels: number): number {
	for (let index = 0; index < HLS_LADDER_TIERS.length - 1; index++) {
		const upper = HLS_LADDER_TIERS[index];
		const lower = HLS_LADDER_TIERS[index + 1];
		if (
			upper &&
			lower &&
			pixels >= WIDESCREEN * upper.shortSide * lower.shortSide
		) {
			return index;
		}
	}
	return HLS_LADDER_TIERS.length - 1;
}

export function planHlsLadder(
	source: HlsLadderSource,
	options: { maxTier?: HlsLadderTierName } = {},
): HlsLadderRung[] {
	const size = { width: source.width, height: source.height };
	if (!(size.width > 0) || !(size.height > 0)) {
		throw new Error("Source video has no usable dimensions");
	}
	const maxTierIndex = Math.max(
		0,
		HLS_LADDER_TIERS.findIndex((tier) => tier.name === options.maxTier),
	);
	const maxTier = HLS_LADDER_TIERS[maxTierIndex] ?? HLS_LADDER_TIERS[0];
	const sourceShort = Math.min(size.width, size.height);
	const topShort = Math.min(sourceShort, maxTier.shortSide);
	const top = fitShortSide(size, topShort);
	const topIndex = Math.max(
		maxTierIndex,
		Math.min(
			tierIndexForShortSide(topShort),
			tierIndexForPixels(top.width * top.height),
		),
	);
	const rungs: HlsLadderRung[] = [];
	for (let index = topIndex; index < HLS_LADDER_TIERS.length; index++) {
		const tier = HLS_LADDER_TIERS[index];
		if (!tier) continue;
		const isTop = index === topIndex;
		if (!isTop && tier.shortSide > topShort * 0.8) continue;
		const fitted = fitShortSide(size, isTop ? topShort : tier.shortSide);
		const previous = rungs[rungs.length - 1];
		if (
			previous &&
			previous.width === fitted.width &&
			previous.height === fitted.height
		) {
			continue;
		}
		rungs.push({
			name: tier.name,
			...fitted,
			maxBitrateKbps: tier.maxBitrateKbps,
		});
	}
	return rungs;
}

const NTSC_FRAME_RATES = [
	{ fps: 24000 / 1001, value: "24000/1001" },
	{ fps: 30000 / 1001, value: "30000/1001" },
	{ fps: 60000 / 1001, value: "60000/1001" },
];
const FALLBACK_FPS = 30;

// Every rendition is put on one fixed frame grid counted from zero. A slice
// encoded on another machine then lands on exactly the frames a whole encode
// would have produced, whatever the source's own frame timing looks like.
export function hlsLadderFrameRate(sourceFps: number): string {
	if (!Number.isFinite(sourceFps) || sourceFps <= 0) {
		return String(FALLBACK_FPS);
	}
	if (sourceFps > MAX_LADDER_FPS) return String(MAX_LADDER_FPS);
	const ntsc = NTSC_FRAME_RATES.find(
		(rate) => Math.abs(rate.fps - sourceFps) < 0.01,
	);
	if (ntsc) return ntsc.value;
	return String(Math.round(sourceFps * 1000) / 1000);
}

const COMMON_FRAME_RATES = [10, 12, 15, 20, 24, 25, 30, 48, 50, 60];
// Capture timestamps wander by a few milliseconds, so a short stretch of a
// steady recording measures a little faster than its real rate.
const FRAME_TIMING_JITTER = 0.05;

// The probe's frame rate is an average over the opening packets. A recording
// that starts on a still screen and then moves is faster than its opening, and
// a grid at the opening rate would drop most of its frames. The grid follows
// the fastest stretch instead. A source whose opening already covers its
// fastest stretch keeps the opening rate, so a constant frame rate source gets
// exactly the grid it always had.
export function hlsLadderSourceFps(
	openingFps: number,
	fastestFps: number | null,
): number {
	const opening =
		Number.isFinite(openingFps) && openingFps > 0 ? openingFps : 0;
	if (
		fastestFps === null ||
		!Number.isFinite(fastestFps) ||
		fastestFps <= opening * (1 + FRAME_TIMING_JITTER)
	) {
		return openingFps;
	}
	return (
		COMMON_FRAME_RATES.find(
			(rate) =>
				rate >= fastestFps / (1 + FRAME_TIMING_JITTER) && rate <= fastestFps,
		) ?? fastestFps
	);
}

export interface HlsLadderArgsInput {
	inputPath: string;
	outputDir: string;
	videoCodec: string;
	hasAudio: boolean;
	sourceFps: number;
	rungs: HlsLadderRung[];
	decodeThreads: string;
	extraInputArgs?: string[];
	nvenc?: { options: NvencOptions; gpuDecode: boolean } | null;
	range?: HlsLadderRange | null;
	hdr?: HdrTransfer | null;
	hdrColor?: HdrColor | null;
}

// An HDR source is converted on the CPU, so it is never decoded on the GPU.
function decodesOnGpu(input: HlsLadderArgsInput): boolean {
	return Boolean(input.nvenc?.gpuDecode) && !input.hdr;
}

export interface HlsLadderRange {
	startSeconds: number;
	durationSeconds?: number;
}

// A slice has to line up with its neighbours to the frame. Both ends are cut by
// a trim filter on the shared frame grid, since -ss and -t round to whichever
// frame is on screen and would repeat or lose one. The slice keeps the source's
// own clock (-copyts), and frag_discont writes it into each fragment; without it
// the offset lands in an edit list that players ignore, and every slice would
// start again at zero.
const SLICE_OUTPUT_ARGS = ["-hls_segment_options", "movflags=+frag_discont"];
// -ss counts from the start of the file while -copyts keeps the file's own
// first timestamp, which is not always zero. -start_at_zero moves that first
// timestamp to zero so seeking, trimming and the audio all share one origin.
const SOURCE_CLOCK_ARGS = ["-copyts", "-start_at_zero"];
const SLICE_SEEK_MARGIN_SECONDS = 2;
// An accurate seek throws away every frame before the seek point. A slice that
// starts inside a still stretch then has no earlier frame to repeat and begins
// at the next source frame, short of its start. Keeping the frames from the
// keyframe before the seek point gives the frame grid one to hold; the trim
// filter still cuts the start exactly.
const SLICE_SEEK_ARGS = ["-noaccurate_seek"];

function sliceSeekSeconds(range: HlsLadderRange): number {
	return Math.max(0, range.startSeconds - SLICE_SEEK_MARGIN_SECONDS);
}

function sliceInputArgs(range: HlsLadderRange | null | undefined): string[] {
	if (!range) return [];
	const seek = sliceSeekSeconds(range);
	return [
		...SLICE_SEEK_ARGS,
		"-ss",
		String(seek),
		...(range.durationSeconds === undefined
			? []
			: [
					"-t",
					String(
						range.startSeconds +
							range.durationSeconds -
							seek +
							SLICE_SEEK_MARGIN_SECONDS,
					),
				]),
		...SOURCE_CLOCK_ARGS,
	];
}

function sliceTrimFilter(range: HlsLadderRange | null | undefined): string {
	if (!range) return "";
	const bounds = [
		...(range.startSeconds > 0 ? [`start=${range.startSeconds}`] : []),
		...(range.durationSeconds === undefined
			? []
			: [`end=${range.startSeconds + range.durationSeconds}`]),
	];
	return bounds.length > 0 ? `trim=${bounds.join(":")},` : "";
}

function ladderFilterGraph(input: HlsLadderArgsInput): string {
	const { rungs, nvenc } = input;
	const toSdr = input.hdr
		? `${hdrToSdrFilter(input.hdr, rungs[0], input.hdrColor)},`
		: "";
	const fpsFilter = `fps=${hlsLadderFrameRate(input.sourceFps)},${sliceTrimFilter(input.range)}${toSdr}`;
	const head = nvenc
		? decodesOnGpu(input)
			? `[0:v]${fpsFilter}`
			: `[0:v]${fpsFilter}format=nv12,hwupload_cuda,`
		: `[0:v]${fpsFilter}`;
	const splits = rungs.map((_, index) => `[s${index}]`).join("");
	const scaled = rungs.map((rung, index) =>
		nvenc
			? `[s${index}]scale_cuda=${rung.width}:${rung.height}:format=nv12[v${index}]`
			: `[s${index}]scale=${rung.width}:${rung.height}:flags=lanczos,format=yuv420p[v${index}]`,
	);
	return [`${head}split=${rungs.length}${splits}`, ...scaled].join(";");
}

export function buildHlsLadderArgs(input: HlsLadderArgsInput): string[] {
	const { rungs, nvenc } = input;
	if (rungs.length === 0) throw new Error("HLS ladder has no renditions");
	const keyframes = `expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+${HLS_LADDER_KEYFRAME_SECONDS}))`;
	const args: string[] = [
		"ffmpeg",
		"-threads",
		input.decodeThreads,
		...(decodesOnGpu(input)
			? [...NVENC_HWACCEL_INPUT_ARGS, "-c:v", `${input.videoCodec}_cuvid`]
			: []),
		...(input.extraInputArgs ?? []),
		...sliceInputArgs(input.range),
		"-i",
		input.inputPath,
		"-filter_complex",
		ladderFilterGraph(input),
	];

	rungs.forEach((rung, index) => {
		args.push(
			"-map",
			`[v${index}]`,
			`-maxrate:v:${index}`,
			`${rung.maxBitrateKbps}k`,
			`-bufsize:v:${index}`,
			`${rung.maxBitrateKbps * 2}k`,
		);
	});

	if (nvenc) {
		args.push(
			"-c:v",
			"h264_nvenc",
			"-preset",
			nvenc.options.preset,
			"-tune",
			"hq",
			"-rc",
			"vbr",
			"-cq",
			String(NVENC_LADDER_CQ),
			"-b:v",
			"0",
			...(nvenc.options.spatialAq ? ["-spatial-aq", "1"] : []),
			"-profile:v",
			"high",
			"-forced-idr",
			"1",
		);
	} else {
		args.push(
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			String(X264_LADDER_CRF),
			"-profile:v",
			"high",
			"-sc_threshold",
			"0",
		);
	}
	// Every rendition must cut on the same frames or players cannot switch
	// between them, so keyframes come from the clock and never from the encoder.
	// B-frames give the first packet a decode time before zero. The muxer can only
	// shift the slice that starts at zero to make room, which leaves it two frames
	// behind the slices after it, so the joins would repeat frames.
	args.push(
		"-bf",
		"0",
		"-g",
		"600",
		"-force_key_frames",
		keyframes,
		"-fps_mode:v",
		"passthrough",
		...(input.hdr ? SDR_COLOR_ARGS : []),
	);

	if (input.hasAudio) {
		args.push(
			"-map",
			"0:a:0",
			"-c:a",
			"aac",
			"-b:a",
			`${HLS_LADDER_AUDIO_BITRATE_KBPS}k`,
			"-ac",
			"2",
		);
	}

	const videoStreams = rungs.map((rung, index) =>
		input.hasAudio
			? `v:${index},agroup:${AUDIO_GROUP},name:${rung.name}`
			: `v:${index},name:${rung.name}`,
	);
	const streamMap = input.hasAudio
		? [
				...videoStreams,
				`a:0,agroup:${AUDIO_GROUP},name:${HLS_LADDER_AUDIO_NAME},default:yes`,
			]
		: videoStreams;

	args.push(
		...(input.range ? SLICE_OUTPUT_ARGS : []),
		"-f",
		"hls",
		"-hls_time",
		String(HLS_LADDER_SEGMENT_SECONDS),
		"-hls_playlist_type",
		"vod",
		"-hls_segment_type",
		"fmp4",
		"-hls_flags",
		"independent_segments+single_file",
		"-master_pl_name",
		HLS_LADDER_MASTER_PLAYLIST,
		"-var_stream_map",
		streamMap.join(" "),
		"-progress",
		"pipe:2",
		"-y",
		`${input.outputDir}/%v.m3u8`,
	);
	return args;
}

export interface HlsLadderRendition {
	name: string;
	playlist: string;
	media: string;
	width: number | null;
	height: number | null;
	bandwidth: number | null;
	averageBandwidth: number | null;
	codecs: string | null;
}

function attribute(line: string, name: string): string | null {
	const match = line.match(
		new RegExp(`(?:^|[:,])${name}=("([^"]*)"|[^,]*)`, "i"),
	);
	if (!match) return null;
	return match[2] ?? match[1] ?? null;
}

function numberAttribute(line: string, name: string): number | null {
	const value = Number(attribute(line, name));
	return Number.isFinite(value) && value > 0 ? value : null;
}

function renditionFiles(uri: string): { name: string; media: string } | null {
	const match = uri.match(/^([A-Za-z0-9_-]+)\.m3u8$/);
	return match?.[1] ? { name: match[1], media: `${match[1]}.m4s` } : null;
}

export function parseHlsLadderMaster(master: string): {
	video: HlsLadderRendition[];
	audio: HlsLadderRendition | null;
} {
	const lines = master
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const video: HlsLadderRendition[] = [];
	let audio: HlsLadderRendition | null = null;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.startsWith("#EXT-X-MEDIA:")) {
			const uri = attribute(line, "URI");
			const files = uri ? renditionFiles(uri) : null;
			if (uri && files && attribute(line, "TYPE") === "AUDIO") {
				audio = {
					...files,
					playlist: uri,
					width: null,
					height: null,
					bandwidth: null,
					averageBandwidth: null,
					codecs: null,
				};
			}
			continue;
		}
		if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
		const uri = lines[index + 1] ?? "";
		const files = renditionFiles(uri);
		if (!files) {
			throw new Error("HLS ladder master playlist has an unexpected variant");
		}
		const resolution = attribute(line, "RESOLUTION")?.match(/^(\d+)x(\d+)$/);
		video.push({
			...files,
			playlist: uri,
			width: resolution ? Number(resolution[1]) : null,
			height: resolution ? Number(resolution[2]) : null,
			bandwidth: numberAttribute(line, "BANDWIDTH"),
			averageBandwidth: numberAttribute(line, "AVERAGE-BANDWIDTH"),
			codecs: attribute(line, "CODECS"),
		});
	}
	if (video.length === 0) {
		throw new Error("HLS ladder master playlist has no variants");
	}
	return { video, audio };
}

export function hlsSegmentDurations(playlist: string): number[] {
	const durations: number[] = [];
	for (const line of playlist.split(/\r?\n/)) {
		const match = line.trim().match(/^#EXTINF:([0-9.]+)/);
		if (match?.[1]) durations.push(Number(match[1]));
	}
	return durations;
}

export function hlsRenditionsAreAligned(
	playlists: string[],
	toleranceSeconds = 0.002,
): boolean {
	const [first, ...rest] = playlists.map(hlsSegmentDurations);
	if (!first || first.length === 0) return false;
	return rest.every(
		(durations) =>
			durations.length === first.length &&
			durations.every(
				(duration, index) =>
					Math.abs(duration - (first[index] ?? Number.NaN)) <= toleranceSeconds,
			),
	);
}

export function buildHlsAudioArgs(input: {
	inputPath: string;
	outputDir: string;
	extraInputArgs?: string[];
}): string[] {
	return [
		"ffmpeg",
		...(input.extraInputArgs ?? []),
		...SOURCE_CLOCK_ARGS,
		"-i",
		input.inputPath,
		"-vn",
		"-map",
		"0:a:0",
		"-c:a",
		"aac",
		"-b:a",
		`${HLS_LADDER_AUDIO_BITRATE_KBPS}k`,
		"-ac",
		"2",
		"-hls_segment_options",
		"movflags=+frag_discont",
		"-f",
		"hls",
		"-hls_time",
		String(HLS_LADDER_SEGMENT_SECONDS),
		"-hls_playlist_type",
		"vod",
		"-hls_segment_type",
		"fmp4",
		"-hls_flags",
		"independent_segments+single_file",
		"-progress",
		"pipe:2",
		"-y",
		`${input.outputDir}/${HLS_LADDER_AUDIO_NAME}.m3u8`,
	];
}

export function planHlsLadderSlices(
	durationSeconds: number,
	workers: number,
	minSliceSeconds = 20,
): HlsLadderRange[] {
	if (!(durationSeconds > 0)) return [{ startSeconds: 0 }];
	const count = Math.max(
		1,
		Math.min(
			Math.floor(workers),
			Math.floor(durationSeconds / minSliceSeconds),
		),
	);
	const sliceSeconds =
		Math.ceil(durationSeconds / count / HLS_LADDER_SEGMENT_SECONDS) *
		HLS_LADDER_SEGMENT_SECONDS;
	const slices: HlsLadderRange[] = [];
	for (let index = 0; index < count; index++) {
		const startSeconds = index * sliceSeconds;
		if (startSeconds >= durationSeconds) break;
		slices.push(
			index === count - 1
				? { startSeconds }
				: { startSeconds, durationSeconds: sliceSeconds },
		);
	}
	const last = slices.at(-1);
	if (last) delete last.durationSeconds;
	return slices;
}

export interface HlsLadderSliceOutput {
	master: string;
	playlists: Record<string, string>;
}

export interface StitchedHlsLadder {
	master: string;
	playlists: Record<string, string>;
	media: { slice: number; source: string; name: string }[];
}

const AUDIO_CODEC = "mp4a.40.2";

function sliceMediaName(rendition: string, slice: number): string {
	return `${rendition}-${slice}.m4s`;
}

function restitchPlaylist(
	playlist: string,
	source: string,
	name: string,
): { lines: string[]; targetDuration: number; seconds: number } {
	const lines: string[] = [];
	let targetDuration = 0;
	let seconds = 0;
	for (const raw of playlist.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("#EXT-X-TARGETDURATION:")) {
			targetDuration = Number(line.slice(line.indexOf(":") + 1));
		} else if (line.startsWith("#EXT-X-MAP:")) {
			if (!line.includes(`URI="${source}"`)) {
				throw new Error("HLS ladder slice has an unexpected init segment");
			}
			lines.push(line.replace(`URI="${source}"`, `URI="${name}"`));
		} else if (line.startsWith("#EXTINF:")) {
			seconds += Number(line.slice("#EXTINF:".length).split(",")[0]);
			lines.push(line);
		} else if (line.startsWith("#EXT-X-BYTERANGE:")) {
			lines.push(line);
		} else if (line === source) {
			lines.push(name);
		} else if (line.length > 0 && !line.startsWith("#")) {
			throw new Error("HLS ladder slice references an unexpected file");
		}
	}
	if (!(seconds > 0)) throw new Error("HLS ladder slice has no segments");
	return { lines, targetDuration, seconds };
}

// Slices are joined by playlist only: each rendition's playlist lists every
// slice's file in order, so no media is copied or rewritten after encoding.
export function stitchHlsLadderSlices(
	slices: HlsLadderSliceOutput[],
	options: { hasAudio: boolean },
): StitchedHlsLadder {
	const [first] = slices;
	if (!first) throw new Error("HLS ladder has no slices");
	const parsed = slices.map((slice) => parseHlsLadderMaster(slice.master));
	const renditions = parseHlsLadderMaster(first.master).video;
	const audioBandwidth = options.hasAudio
		? HLS_LADDER_AUDIO_BITRATE_KBPS * 1000
		: 0;
	const playlists: Record<string, string> = {};
	const media: StitchedHlsLadder["media"] = [];
	const master = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
	if (options.hasAudio) {
		master.push(
			`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${AUDIO_GROUP}",NAME="${HLS_LADDER_AUDIO_NAME}",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${HLS_LADDER_AUDIO_NAME}.m3u8"`,
		);
	}

	for (const [index, rendition] of renditions.entries()) {
		const body: string[] = [];
		let targetDuration = 0;
		let totalSeconds = 0;
		let weightedAverage = 0;
		let peak = 0;
		for (const [slice, output] of slices.entries()) {
			const variant = parsed[slice]?.video[index];
			const playlist = output.playlists[rendition.name];
			if (!variant || variant.name !== rendition.name || !playlist) {
				throw new Error("HLS ladder slices have different renditions");
			}
			const name = sliceMediaName(rendition.name, slice);
			const stitched = restitchPlaylist(playlist, rendition.media, name);
			body.push(...stitched.lines);
			media.push({ slice, source: rendition.media, name });
			targetDuration = Math.max(targetDuration, stitched.targetDuration);
			totalSeconds += stitched.seconds;
			weightedAverage +=
				(variant.averageBandwidth ?? variant.bandwidth ?? 0) * stitched.seconds;
			peak = Math.max(peak, variant.bandwidth ?? 0);
		}
		playlists[rendition.playlist] = `${[
			"#EXTM3U",
			"#EXT-X-VERSION:7",
			`#EXT-X-TARGETDURATION:${targetDuration}`,
			"#EXT-X-MEDIA-SEQUENCE:0",
			"#EXT-X-PLAYLIST-TYPE:VOD",
			"#EXT-X-INDEPENDENT-SEGMENTS",
			...body,
			"#EXT-X-ENDLIST",
		].join("\n")}\n`;
		const codecs = [rendition.codecs, options.hasAudio ? AUDIO_CODEC : null]
			.filter((codec): codec is string => Boolean(codec))
			.join(",");
		const attributes = [
			`BANDWIDTH=${peak + audioBandwidth}`,
			`AVERAGE-BANDWIDTH=${Math.round(weightedAverage / totalSeconds) + audioBandwidth}`,
			...(rendition.width && rendition.height
				? [`RESOLUTION=${rendition.width}x${rendition.height}`]
				: []),
			...(codecs ? [`CODECS="${codecs}"`] : []),
			...(options.hasAudio ? [`AUDIO="${AUDIO_GROUP}"`] : []),
		];
		master.push(
			`#EXT-X-STREAM-INF:${attributes.join(",")}`,
			rendition.playlist,
		);
	}

	for (const output of slices) {
		const sliceLists = renditions.map(
			(rendition) => output.playlists[rendition.name] ?? "",
		);
		if (!hlsRenditionsAreAligned(sliceLists)) {
			throw new Error("HLS ladder renditions are not cut at the same times");
		}
	}

	return { master: `${master.join("\n")}\n`, playlists, media };
}

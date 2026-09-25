import type { FetchStats, FileSpec } from "./materialize";
import type { Run } from "./mp4";

export const COMPRESSION_BPP = {
	Maximum: 0.3,
	Social: 0.15,
	Web: 0.08,
	Potato: 0.04,
} as const;

export type Compression = keyof typeof COMPRESSION_BPP;

export const MIN_PART = 5 * 1024 * 1024;

export type VideoTask = {
	kind: "video";
	taskId: string;
	jobId: string;
	chunk: number;
	fps: number;
	resolution: [number, number];
	bpp: number;
	frames: [number, number];
	/** x264 threads, fixed per job: output bytes must not depend on the machine. */
	threads: number;
	files: FileSpec[];
	upload: {
		key: string;
		uploadId: string;
		firstPart: number;
		partLimit: number;
		partTarget: number;
		/** The final chunk may end in a part smaller than S3's minimum. */
		isLast: boolean;
	};
	audio: { first: number; end: number; coordinator: string } | null;
	/** Stream playable fMP4 segments to `${prefix}/c<chunk>-<n>.m4s` while rendering. */
	hls: { prefix: string; segmentFrames: number } | null;
};

export type SegmentReport = {
	chunk: number;
	index: number;
	/** Global output frames [first, end). */
	frames: [number, number];
	key: string;
	/** The chunk's final segment. */
	last: boolean;
	/** Base64 Annex B SPS/PPS, for the init segment. */
	extradata: string;
};

export type AudioTask = {
	kind: "audio";
	taskId: string;
	jobId: string;
	section: number;
	fps: number;
	range: [number, number];
	preroll: number;
	files: FileSpec[];
};

export type Task = VideoTask | AudioTask;

export type TaskTimings = {
	queuedMs: number;
	fetch: FetchStats;
	engine: Record<string, number>;
	engineMs: number;
	audioWaitMs: number;
	uploadMs: number;
	totalMs: number;
	cpuSeconds: number;
};

export type VideoResult = {
	taskId: string;
	worker: string;
	sizes: number[];
	keyframes: number[];
	extradata: string;
	width: number;
	height: number;
	/** Runs relative to the chunk's first byte; `first` is a global sample index. */
	videoRuns: Run[];
	audioRuns: Run[];
	parts: { partNumber: number; etag: string; size: number }[];
	bytes: number;
	paddedBytes: number;
	timings: TaskTimings;
};

export type AudioResultMeta = {
	taskId: string;
	worker: string;
	firstPacket: number;
	sizes: number[];
	extradata: string;
	timings: TaskTimings;
};

export type JobRequest = {
	recording: string;
	fps?: number;
	resolution?: [number, number];
	compression?: Compression;
	/** Upper bound on video chunks; defaults to one per registered slot. */
	maxChunks?: number;
	minChunkSeconds?: number;
	chunksPerSlot?: number;
	/** Target render seconds per chunk. */
	chunkWorkSeconds?: number;
	duplicateStragglers?: boolean;
	label?: string;
	/** Profiling: export only the first N frames, without audio. */
	frameLimit?: number;
	/** Pin the chunk count (profiling). */
	chunks?: number;
};

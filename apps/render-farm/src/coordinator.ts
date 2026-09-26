import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "./engine";
import { initSegment, playlist } from "./fmp4";
import { checkSegmentReport, segmentCuts, segmentKey } from "./hls";
import { type FileSpec, ProjectCache } from "./materialize";
import {
	avcC,
	buildHeader,
	byteRangeFor,
	indexVideoTrack,
	locateMoov,
	type Run,
	type TrackIndex,
} from "./mp4";
import { planChunkBoundaries } from "./planning";
import { ProbeEngine } from "./probe-engine";
import {
	type AudioResultMeta,
	type AudioTask,
	COMPRESSION_BPP,
	type JobRequest,
	MIN_PART,
	type SegmentReport,
	type Task,
	type VideoResult,
	type VideoTask,
} from "./protocol";
import {
	acceptOnce,
	completeUpload,
	PART_RANGES,
	reservePartRange,
} from "./recovery";
import { S3, s3ConfigFromEnv } from "./s3";
import { pickQueued as pickQueuedTask } from "./scheduler";
import {
	AUDIO_FILE,
	checkManifestBounds,
	sourceLimitsFromEnv,
	validateJobRequest,
} from "./validate";

const s3 = new S3(s3ConfigFromEnv());
const ENGINE_BIN = process.env.RF_ENGINE_BIN ?? "cap-render-farm";
const WORK_DIR = process.env.RF_WORK_DIR ?? "/tmp/rf-coordinator";
const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_URL = process.env.RF_COORDINATOR_URL ?? `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.RF_TOKEN ?? "";
if (!TOKEN && process.env.RF_ALLOW_NO_TOKEN !== "1") {
	throw new Error(
		"RF_TOKEN is required (set RF_ALLOW_NO_TOKEN=1 for local use)",
	);
}
const MAX_ACTIVE_JOBS = Number(process.env.RF_MAX_ACTIVE_JOBS ?? 32);
// A job whose tasks stop completing (every attempt failing slowly, a lost
// dependency) would otherwise hold its upload and waiters forever.
const JOB_STALL_MS = Number(process.env.RF_JOB_STALL_MS ?? 10 * 60_000);
// Finished jobs stay queryable this long, as a summary without media data.
const JOB_RETENTION_MS = Number(process.env.RF_JOB_RETENTION_MS ?? 60 * 60_000);
const SAMPLE_RATE = 48_000;
const PACKET = 1024;

const probeEngine = new ProbeEngine(
	() => new Engine(ENGINE_BIN, {}, "coordinator-engine"),
);

// Audio sections (Studio Sound) are CPU work. These lanes render them on the
// coordinator's cores, pulling from the same queue as workers' audio lanes.
const LOCAL_AUDIO_SLOTS = Number(process.env.RF_LOCAL_AUDIO_SLOTS ?? 2);
// Progressive playback: chunks stream fMP4 segments while rendering and the
// coordinator keeps an HLS EVENT playlist of the contiguous prefix, so an
// export is watchable seconds after the request whatever its length. The
// flat MP4 is still assembled for download.
const HLS = process.env.RF_HLS !== "0";
const HLS_SEGMENT_SECONDS = Number(process.env.RF_HLS_SEGMENT_SECONDS ?? 2);
/** Unfinished chunks per job (from the front) that outrank other work. */
const HEAD_CHUNKS = Number(process.env.RF_HEAD_CHUNKS ?? 2);
const LEAD_IN_SECONDS = Number(process.env.RF_LEAD_IN_SECONDS ?? 4);
const SLOT_MEGAPIXELS_PER_SEC = Number(
	process.env.RF_SLOT_MEGAPIXELS_PER_SEC ?? 450,
);
const CHUNK_WORK_SECONDS = Number(process.env.RF_CHUNK_WORK_SECONDS ?? 6);
const audioEngines = Array.from(
	{ length: LOCAL_AUDIO_SLOTS },
	(_, index) => new Engine(ENGINE_BIN, {}, `audio${index}`),
);
const idleAudioEngines = [...audioEngines];
const localAudioQueue: (() => void)[] = [];
async function withAudioEngine<T>(fn: (engine: Engine) => Promise<T>) {
	while (idleAudioEngines.length === 0) {
		await new Promise<void>((resolve) => localAudioQueue.push(resolve));
	}
	let engine = idleAudioEngines.pop() as Engine;
	if (!engine.alive) engine = new Engine(ENGINE_BIN, {}, engine.label);
	try {
		return await fn(engine);
	} finally {
		idleAudioEngines.push(engine);
		localAudioQueue.shift()?.();
	}
}

/**
 * Local audio lanes pull from the shared queue like any fleet audio lane, so
 * sections spread over the coordinator's cores and the workers' idle CPUs.
 */
let localAudioRunning = 0;
function pumpLocalAudio() {
	while (localAudioRunning < LOCAL_AUDIO_SLOTS) {
		const index = pickQueued((kind) => kind === "audio");
		if (index < 0) return;
		const state = queue.splice(index, 1)[0] as TaskState;
		const job = jobs.get(state.task.jobId);
		if (!job || job.status !== "rendering") continue;
		state.attempts++;
		job.t.firstTaskStarted ??= now();
		localAudioRunning++;
		runAudioLocally(job, state).finally(() => {
			localAudioRunning--;
			pumpLocalAudio();
		});
	}
}

async function runAudioLocally(job: Job, state: TaskState) {
	const task = state.task;
	if (task.kind !== "audio") return;
	state.state = "running";
	state.startedAt = now();
	state.worker = "coordinator";
	try {
		const started = performance.now();
		if (!job.audioCache) {
			job.audioCache = new ProjectCache(s3, join(WORK_DIR, job.id, "audio"));
		}
		const cache = job.audioCache;
		mkdirSync(cache.root, { recursive: true });
		const fetch = await cache.materialize(task.files);
		const out = join(cache.root, `a${task.section}.aac`);
		const engineStarted = performance.now();
		const result = await withAudioEngine((engine) =>
			engine.request<{
				first_packet: number;
				sizes: number[];
				extradata: string;
				timings: Record<string, number>;
			}>("audio", {
				project: cache.root,
				fps: task.fps,
				section: task.range,
				preroll: task.preroll,
				out,
			}),
		);
		const data = new Uint8Array(await Bun.file(out).arrayBuffer());
		rmSync(out, { force: true });
		const meta: AudioResultMeta = {
			taskId: task.taskId,
			worker: "coordinator",
			firstPacket: result.first_packet,
			sizes: result.sizes,
			extradata: result.extradata,
			timings: {
				queuedMs: 0,
				fetch,
				engine: result.timings,
				engineMs: performance.now() - engineStarted,
				audioWaitMs: 0,
				uploadMs: 0,
				totalMs: performance.now() - started,
				cpuSeconds: 0,
			},
		};
		if (job.status === "rendering") await onAudioDone(job, state, meta, data);
	} catch (error) {
		if (state.attempts >= 3) failJob(job, error);
		else
			setTimeout(() => {
				if (job.status !== "rendering" || job.audioSections.has(task.section))
					return;
				requeue(state, "local audio lane failed");
				pumpLocalAudio();
				dispatch();
			}, 1000 * state.attempts);
	}
}

type Usage = { cpuSeconds: number; memoryBytes: number; at: number };

type Worker = {
	id: string;
	slots: number;
	cpus: number;
	lastSeen: number;
	service: string;
	audioSlots?: number;
	usage?: Usage | null;
};

type Section = {
	index: number;
	range: [number, number];
	preroll: number;
	exact: boolean;
	packets: [number, number];
};

type Chunk = {
	index: number;
	frames: [number, number];
	packets: [number, number];
	files: FileSpec[];
	firstPart: number;
	partLimit: number;
	/** Copies dispatched so far; picks each dispatch's part range. */
	dispatches: number;
};

type TaskState = {
	task: Task;
	state: "queued" | "running" | "done";
	worker?: string;
	startedAt?: number;
	attempts: number;
	dispatching?: boolean;
	reattach?: boolean;
	firstPart?: number;
	duplicateOf?: string;
	duplicated?: boolean;
	/** Reserved by a busy slot ahead of time; not started until it reports progress. */
	prefetched?: boolean;
	/**
	 * Resumed after a coordinator restart: a worker may still be running it.
	 * Held back until then so its heartbeat can re-attach it instead of the
	 * chunk being rendered twice.
	 */
	heldUntil?: number;
	/** Last heartbeat in which the owning worker listed this task. */
	lastReportedAt?: number;
	progress?: {
		frames: number;
		total: number;
		elapsedMs: number;
		at: number;
		advancedAt: number;
	};
};

type HlsState = {
	prefix: string;
	url: string;
	initUrl?: string;
	extradata?: string;
	segments: Map<number, Map<number, SegmentReport>>;
	listed: { url: string; duration: number }[];
	cursor: { chunk: number; index: number };
	writing: boolean;
	dirty: boolean;
	ended: boolean;
	audioExtradata?: string;
	retry?: ReturnType<typeof setTimeout>;
};

type Job = {
	verified?: boolean;
	acceptances: Map<string, Promise<void>>;
	/** Summary frozen when the job ends; the job's media data is released then. */
	final?: ReturnType<typeof summary>;
	hls?: HlsState;
	id: string;
	request: JobRequest;
	status: "planning" | "rendering" | "assembling" | "ready" | "error";
	error?: string;
	key: string;
	uploadId?: string;
	t: Record<string, number>;
	fps: number;
	bpp: number;
	resolution: [number, number];
	totalFrames: number;
	totalSamples: number;
	width: number;
	height: number;
	chunks: Chunk[];
	sections: Section[];
	tasks: Map<string, TaskState>;
	videoResults: Map<number, VideoResult>;
	audioSections: Map<number, { meta: AudioResultMeta; data: Uint8Array }>;
	audioWaiters: (() => void)[];
	cpuSeconds: number;
	fetchedBytes: number;
	workersUsed: Set<string>;
	url?: string;
	outputBytes?: number;
	probe?: Record<string, unknown>;
	plan?: Record<string, unknown>;
	waiters: (() => void)[];
	taskStats: Record<string, unknown>[];
	audioCache?: ProjectCache;
};

const workers = new Map<string, Worker>();
const jobs = new Map<string, Job>();
const queue: TaskState[] = [];
type Poller = {
	worker: string;
	kinds?: string[];
	/** A busy slot reserving its next task: queued work only, never a hedge. */
	prefetch?: boolean;
	resolve: (task: Task | null) => void;
};
const pollers: Poller[] = [];
const finishedJobs: string[] = [];

function now() {
	return performance.timeOrigin + performance.now();
}

function liveSlots() {
	const cutoff = Date.now() - 30_000;
	let slots = 0;
	let audioSlots = 0;
	let count = 0;
	for (const worker of workers.values()) {
		if (worker.lastSeen >= cutoff) {
			slots += worker.slots;
			audioSlots += worker.audioSlots ?? 0;
			count++;
		}
	}
	return { slots, audioSlots, workers: count };
}

async function newJob(
	id: string,
	request: JobRequest,
	requestedAt = now(),
): Promise<Job> {
	const compression = request.compression ?? "Maximum";
	const job: Job = {
		id,
		acceptances: new Map(),
		request,
		status: "planning",
		key: `out/${id}.mp4`,
		t: { requested: requestedAt },
		fps: request.fps ?? 30,
		bpp: COMPRESSION_BPP[compression],
		resolution: request.resolution ?? [1920, 1080],
		totalFrames: 0,
		totalSamples: 0,
		width: 0,
		height: 0,
		chunks: [],
		sections: [],
		tasks: new Map(),
		videoResults: new Map(),
		audioSections: new Map(),
		audioWaiters: [],
		cpuSeconds: 0,
		fetchedBytes: 0,
		workersUsed: new Set(),
		waiters: [],
		taskStats: [],
	};
	if (HLS) job.hls = await newHlsState(`hls/${id}`);
	return job;
}

// ---------------------------------------------------------------- planning ---

type Manifest = { files: { path: string; size: number; key?: string }[] };

type RecordingMeta = {
	segments?: {
		display: { path: string; start_time?: number };
		camera?: { path: string; start_time?: number };
		mic?: { path: string };
		system_audio?: { path: string };
	}[];
	display?: { path: string };
	camera?: { path: string };
	audio?: { path: string };
};

async function mp4MetaRanges(key: string, size: number) {
	const headEnd = Math.min(size, 128 * 1024);
	const head = await s3.getRange(key, 0, headEnd - 1);
	const location = locateMoov(head, size);
	let moovStart: number;
	let moovBytes: Uint8Array;
	if (location && "start" in location && location.start !== undefined) {
		if (location.size > SOURCE_LIMITS.moovBytes) {
			throw new Error(`${key} has a ${location.size} byte moov`);
		}
		moovStart = location.start;
		moovBytes =
			location.start + location.size <= head.byteLength
				? head.subarray(location.start, location.start + location.size)
				: await s3.getRange(
						key,
						location.start,
						location.start + location.size - 1,
					);
	} else if (location && "next" in location && location.next !== undefined) {
		// Moov after mdat (Cap's recorder): fetch the tail in one request.
		if (size - location.next > SOURCE_LIMITS.moovBytes) {
			throw new Error(`${key} has ${size - location.next} bytes after mdat`);
		}
		const tail = await s3.getRange(key, location.next, size - 1);
		const found = locateMoov(tail, tail.byteLength);
		if (!found || !("start" in found) || found.start === undefined) {
			throw new Error(`no moov in ${key}`);
		}
		moovStart = location.next + found.start;
		moovBytes = tail.subarray(found.start, found.start + found.size);
	} else {
		throw new Error(`no moov in ${key}`);
	}
	return {
		head: [0, headEnd] as [number, number],
		moov: [moovStart, moovStart + moovBytes.byteLength] as [number, number],
		index: indexVideoTrack(moovBytes),
	};
}

function mergeRanges(ranges: [number, number][]) {
	const sorted = ranges
		.filter(([start, end]) => end > start)
		.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1] + 256 * 1024)
			last[1] = Math.max(last[1], range[1]);
		else merged.push([range[0], range[1]]);
	}
	return merged;
}

type SourceIndex = {
	manifest: Manifest;
	recordingMeta: RecordingMeta;
	mediaMeta: Map<
		string,
		{
			head: [number, number];
			moov: [number, number];
			index: TrackIndex;
			size: number;
			key: string;
		}
	>;
};
// Stand-in for an index built once at upload time: recordings are immutable
// once uploaded, so their moov indexes never need re-reading per export.
const sourceIndexes = new Map<string, SourceIndex>();

// Shared prefixes a manifest may point sources at besides its own recording
// prefix (e.g. assets reused across recordings), comma-separated.
const SOURCE_KEY_PREFIXES = (process.env.RF_SOURCE_KEY_PREFIXES ?? "")
	.split(",")
	.filter(Boolean);

const SOURCE_LIMITS = sourceLimitsFromEnv(process.env);

async function getBounded(key: string, limit: number) {
	const bytes = await s3.getRange(key, 0, limit);
	if (bytes.byteLength > limit) {
		throw new Error(`${key} is larger than ${limit} bytes`);
	}
	return bytes;
}

/** Manifests name local paths and bucket keys; neither may escape its scope. */
function checkManifest(manifest: Manifest, prefix: string) {
	const bounds = checkManifestBounds(manifest, SOURCE_LIMITS);
	if (bounds) throw new Error(bounds);
	for (const file of manifest.files) {
		const parts = file.path.split("/");
		if (
			file.path.startsWith("/") ||
			parts.includes("..") ||
			parts.includes("")
		) {
			throw new Error(`manifest path ${file.path} is not a relative path`);
		}
		if (
			file.key !== undefined &&
			!file.key.startsWith(`${prefix}/`) &&
			!SOURCE_KEY_PREFIXES.some((allowed) => file.key?.startsWith(allowed))
		) {
			throw new Error(`manifest key for ${file.path} is outside the recording`);
		}
	}
}

async function sourceIndex(prefix: string): Promise<SourceIndex> {
	const cached =
		process.env.RF_INDEX_CACHE !== "0" ? sourceIndexes.get(prefix) : undefined;
	if (cached) return cached;
	const manifest = JSON.parse(
		new TextDecoder().decode(
			await getBounded(`${prefix}/manifest.json`, SOURCE_LIMITS.metadataBytes),
		),
	) as Manifest;
	checkManifest(manifest, prefix);
	const keyOf = (file: { path: string; key?: string }) =>
		file.key ?? `${prefix}/${file.path}`;
	const metaFile = manifest.files.find(
		(file) => file.path === "recording-meta.json",
	);
	if (!metaFile) throw new Error("recording has no recording-meta.json");
	const recordingMeta = JSON.parse(
		new TextDecoder().decode(
			await getBounded(keyOf(metaFile), SOURCE_LIMITS.metadataBytes),
		),
	) as RecordingMeta;
	const mediaMeta: SourceIndex["mediaMeta"] = new Map();
	await Promise.all(
		manifest.files
			.filter((file) => file.path.endsWith(".mp4"))
			.map(async (file) => {
				const meta = await mp4MetaRanges(keyOf(file), file.size);
				mediaMeta.set(file.path, {
					...meta,
					size: file.size,
					key: keyOf(file),
				});
			}),
	);
	const index = { manifest, recordingMeta, mediaMeta };
	sourceIndexes.set(prefix, index);
	if (sourceIndexes.size > 32)
		sourceIndexes.delete(sourceIndexes.keys().next().value as string);
	return index;
}

async function planJob(job: Job) {
	const request = job.request;
	const prefix = request.recording.replace(/\/$/, "");
	const { manifest, recordingMeta, mediaMeta } = await sourceIndex(prefix);

	const keyOf = (file: { path: string; key?: string }) =>
		file.key ?? `${prefix}/${file.path}`;

	const mediaFiles = manifest.files.filter((file) =>
		file.path.endsWith(".mp4"),
	);
	const audioFiles = manifest.files.filter((file) =>
		AUDIO_FILE.test(file.path),
	);
	const smallFiles = manifest.files.filter(
		(file) => !mediaFiles.includes(file) && !audioFiles.includes(file),
	);

	job.t.indexed = now();

	const baseSpecs = (audioMode: "probe" | "all"): FileSpec[] => [
		...smallFiles.map((file) => ({
			path: file.path,
			key: keyOf(file),
			size: file.size,
			ranges: "all" as const,
		})),
		...audioFiles.map((file) => ({
			path: file.path,
			key: keyOf(file),
			size: file.size,
			ranges:
				audioMode === "all"
					? ("all" as const)
					: mergeRanges([
							[0, Math.min(file.size, 256 * 1024)],
							[Math.max(0, file.size - 256 * 1024), file.size],
						]),
		})),
	];
	const mediaSpec = (path: string, extra: [number, number][]): FileSpec => {
		const meta = mediaMeta.get(path);
		if (!meta) throw new Error(`no index for ${path}`);
		return {
			path,
			key: meta.key,
			size: meta.size,
			ranges: mergeRanges([meta.head, meta.moov, ...extra]),
		};
	};

	const probeDir = join(WORK_DIR, job.id);
	mkdirSync(probeDir, { recursive: true });
	const cache = new ProjectCache(s3, probeDir);
	await cache.materialize([
		...baseSpecs("probe"),
		...mediaFiles.map((file) => mediaSpec(file.path, [])),
	]);
	job.t.materialized = now();

	const gop = job.fps * 2;
	type Probe = {
		total_frames: number;
		total_samples: number;
		width: number;
		height: number;
		span_step: number;
		spans: { clip: number; start: number; end: number }[][];
		audio_cuts: number[];
		clips: { index: number; camera: number; mic: number }[];
	};
	const probe = await probeEngine
		.request<Probe>({
			project: probeDir,
			fps: job.fps,
			resolution: job.resolution,
			span_step: gop,
		})
		.finally(() => cache.close());
	job.t.probed = now();
	if (request.frameLimit && request.frameLimit < probe.total_frames) {
		probe.total_frames = request.frameLimit;
		probe.total_samples = Math.round(
			(request.frameLimit * SAMPLE_RATE) / job.fps,
		);
	}
	if (probe.total_frames > job.fps * SOURCE_LIMITS.exportSeconds) {
		throw new Error(
			`export is ${Math.round(probe.total_frames / job.fps)} s (limit ${SOURCE_LIMITS.exportSeconds} s)`,
		);
	}
	job.totalFrames = probe.total_frames;
	job.totalSamples = probe.total_samples;
	job.width = probe.width;
	job.height = probe.height;
	job.probe = {
		totalFrames: probe.total_frames,
		width: probe.width,
		height: probe.height,
		audioCuts: probe.audio_cuts.length,
	};

	// Which media files belong to which recording clip.
	const clipMedia: { display?: string; camera?: string; offset: number }[] = [];
	const segments: NonNullable<RecordingMeta["segments"]> =
		recordingMeta.segments ?? [
			{
				display: recordingMeta.display ?? { path: "" },
				camera: recordingMeta.camera,
			},
		];
	segments.forEach((segment, index) => {
		const cameraOffset =
			probe.clips.find((clip) => clip.index === index)?.camera ?? 0;
		const starts = [
			segment.display.start_time ?? 0,
			segment.camera?.start_time ?? 0,
		];
		clipMedia[index] = {
			display: segment.display.path,
			camera: segment.camera?.path,
			offset:
				Math.abs(cameraOffset) + Math.max(...starts) - Math.min(...starts),
		};
	});

	// ---- video chunks
	const { slots } = liveSlots();
	const minChunkFrames = Math.max(
		1,
		Math.round((request.minChunkSeconds ?? 1) * job.fps),
	);
	// Chunks are sized by render work, not video length, so 4K gets shorter
	// chunks than 1080p. ~6 s of work per chunk measured the same single-job
	// speed as 12 s while freeing slots twice as often for exports that arrive
	// during a long one.
	const megapixels = (probe.width * probe.height) / 1e6;
	const slotFps = SLOT_MEGAPIXELS_PER_SEC / megapixels;
	const targetFrames = Math.max(
		minChunkFrames,
		Math.round(slotFps * (request.chunkWorkSeconds ?? CHUNK_WORK_SECONDS)),
	);
	const boundaries = planChunkBoundaries({
		totalFrames: probe.total_frames,
		fps: job.fps,
		slots,
		targetFrames,
		minChunkFrames,
		chunks: request.chunks,
		chunksPerSlot: request.chunksPerSlot,
		maxChunks: request.maxChunks,
		leadInFrames: job.hls ? LEAD_IN_SECONDS * job.fps : 0,
	});
	const chunkCount = boundaries.length - 1;
	const partsPerChunk = Math.floor(9998 / chunkCount);
	const partLimit = Math.floor(partsPerChunk / PART_RANGES);
	if (partLimit < 3) {
		throw new Error("too many chunks for one multipart upload");
	}
	const samplesPerFrame = SAMPLE_RATE / job.fps;
	const totalPackets = Math.ceil(probe.total_samples / PACKET) + 1;
	const packetAt = (frame: number, isStart: boolean, isEnd: boolean) => {
		if (isStart) return 0;
		if (isEnd) return totalPackets;
		return Math.ceil((frame * samplesPerFrame) / PACKET) + 1;
	};
	const margin = 2;
	job.chunks = [];
	for (let index = 0; index < chunkCount; index++) {
		const f0 = boundaries[index] ?? 0;
		const f1 = boundaries[index + 1] ?? probe.total_frames;
		const perFile = new Map<string, [number, number][]>();
		for (let step = Math.floor(f0 / gop); step < Math.ceil(f1 / gop); step++) {
			for (const span of probe.spans[step] ?? []) {
				const media = clipMedia[span.clip];
				if (!media) continue;
				const pad = margin + media.offset;
				for (const path of [media.display, media.camera]) {
					if (!path) continue;
					const meta = mediaMeta.get(path);
					if (!meta) continue;
					const range = byteRangeFor(
						meta.index,
						span.start - pad,
						span.end + pad,
					);
					if (!range) continue;
					const list = perFile.get(path) ?? [];
					list.push([range.start, range.end]);
					perFile.set(path, list);
				}
			}
		}
		job.chunks.push({
			index,
			frames: [f0, f1],
			packets: [
				packetAt(f0, index === 0, false),
				packetAt(f1, false, index === chunkCount - 1),
			],
			files: [
				...baseSpecs("probe"),
				...mediaFiles.map((file) =>
					mediaSpec(file.path, perFile.get(file.path) ?? []),
				),
			],
			firstPart: 2 + index * partsPerChunk,
			partLimit,
			dispatches: 0,
		});
	}

	// ---- audio sections, split on clip boundaries where Studio Sound resets
	const hasAudio = audioFiles.length > 0 && !request.frameLimit;
	job.sections = [];
	if (hasAudio) {
		const total = probe.total_samples;
		// One wave of sections across whoever renders audio (the coordinator's
		// local slots, or the fleet).
		const fleetAudio = liveSlots().audioSlots;
		const audioLanes =
			LOCAL_AUDIO_SLOTS + fleetAudio > 0
				? LOCAL_AUDIO_SLOTS + fleetAudio
				: Math.max(8, slots);
		const target = Math.max(
			20 * SAMPLE_RATE,
			Math.ceil(total / Math.min(64, audioLanes)),
		);
		const cuts = probe.audio_cuts;
		let start = 0;
		let preroll = 0;
		let exact = true;
		// With HLS the first segment waits on section 0's audio: keep it short
		// so playback can start well before the long sections finish.
		const firstTarget = job.hls ? Math.min(target, 6 * SAMPLE_RATE) : target;
		while (start < total) {
			const size = job.sections.length === 0 ? firstTarget : target;
			const ideal = start + size;
			if (ideal >= total - size / 2) {
				job.sections.push({
					index: job.sections.length,
					range: [start, total],
					preroll,
					exact,
					packets: [start === 0 ? 0 : (start + PACKET) / PACKET, totalPackets],
				});
				break;
			}
			const cut = cuts.find(
				(value) => value >= ideal - size / 2 && value <= ideal + size / 2,
			);
			let end: number;
			let nextPreroll: number;
			let nextExact: boolean;
			if (cut !== undefined) {
				end = Math.ceil((cut + PACKET) / PACKET) * PACKET;
				const inputStart = Math.max(
					0,
					Math.floor((cut - 2 * SAMPLE_RATE) / PACKET) * PACKET,
				);
				nextPreroll = end - inputStart;
				nextExact = true;
			} else {
				end = Math.floor(ideal / PACKET) * PACKET;
				nextPreroll = Math.min(
					end,
					Math.floor((10 * SAMPLE_RATE) / PACKET) * PACKET,
				);
				nextExact = false;
			}
			job.sections.push({
				index: job.sections.length,
				range: [start, end],
				preroll,
				exact,
				packets: [
					start === 0 ? 0 : (start + PACKET) / PACKET,
					(end + PACKET) / PACKET,
				],
			});
			start = end;
			preroll = nextPreroll;
			exact = nextExact;
		}
	}

	job.uploadId = await s3.createMultipart(job.key, "video/mp4");
	job.t.planned = now();

	const bitrate =
		job.width * job.height * (30 + Math.max(0, job.fps - 30) * 0.6) * job.bpp;
	// Sized for the largest chunk, with 2.5x headroom for bitrate peaks.
	const largestChunkFrames = Math.max(
		...job.chunks.map((chunk) => chunk.frames[1] - chunk.frames[0]),
	);
	const largestChunkBytes = (bitrate / 8) * (largestChunkFrames / job.fps);
	const partTarget = Math.max(
		16 << 20,
		Math.ceil((largestChunkBytes * 2.5) / Math.max(1, partLimit - 2)),
	);
	job.plan = {
		chunks: chunkCount,
		sections: job.sections.length,
		exactSeams: job.sections.filter((section) => section.exact).length,
		slots,
		partsPerChunk,
		partTarget,
		sourceBytesPerChunk: Math.round(
			job.chunks.reduce(
				(sum, chunk) =>
					sum +
					chunk.files.reduce(
						(fileSum, file) =>
							fileSum +
							(file.ranges === "all"
								? file.size
								: file.ranges.reduce((r, [a, b]) => r + b - a, 0)),
						0,
					),
				0,
			) / chunkCount,
		),
	};

	for (const section of job.sections) {
		const task: AudioTask = {
			kind: "audio",
			taskId: `${job.id}:a${section.index}`,
			jobId: job.id,
			section: section.index,
			fps: job.fps,
			range: section.range,
			preroll: section.preroll,
			files: [
				...baseSpecs("all"),
				...mediaFiles.map((file) => mediaSpec(file.path, [])),
			],
		};
		enqueue(job, task);
	}
	for (const chunk of job.chunks) {
		const task: VideoTask = {
			kind: "video",
			taskId: `${job.id}:v${chunk.index}`,
			jobId: job.id,
			chunk: chunk.index,
			fps: job.fps,
			resolution: job.resolution,
			bpp: job.bpp,
			frames: chunk.frames,
			threads: 8,
			files: chunk.files,
			upload: {
				key: job.key,
				uploadId: job.uploadId,
				firstPart: chunk.firstPart,
				partLimit: chunk.partLimit,
				partTarget,
				isLast: chunk.index === job.chunks.length - 1,
			},
			audio: hasAudio
				? {
						first: chunk.packets[0],
						end: chunk.packets[1],
						coordinator: PUBLIC_URL,
					}
				: null,
			hls: job.hls
				? {
						prefix: job.hls.prefix,
						segmentFrames: Math.round(job.fps * HLS_SEGMENT_SECONDS),
					}
				: null,
		};
		enqueue(job, task);
	}
	await journalJob(job);
	job.status = "rendering";
	dispatch();
}

// ----------------------------------------------------------------- journal ---
// With RF_JOURNAL=1 a coordinator restart (crash, deploy) resumes in-flight
// exports instead of losing them: the plan is written before dispatch, each
// accepted chunk/audio result as it lands, and a marker when the job ends.
// On boot, unfinished jobs are rebuilt and only their missing work re-queued;
// the multipart upload and every uploaded part are reused.

const JOURNAL = process.env.RF_JOURNAL !== "0";
// Workers heartbeat every 3 s; this is enough for all of them to report in.
const RESUME_HOLD_MS = 10_000;
const journalKey = (id: string, name: string) => `jobs/${id}/${name}`;

async function journalPut(key: string, body: Uint8Array | string) {
	if (!JOURNAL) return;
	await s3.put(key, body);
}

type JournaledJob = Pick<
	Job,
	| "id"
	| "request"
	| "key"
	| "uploadId"
	| "t"
	| "fps"
	| "bpp"
	| "resolution"
	| "totalFrames"
	| "totalSamples"
	| "width"
	| "height"
	| "chunks"
	| "sections"
	| "plan"
	| "probe"
> & { version: 2; tasks: Task[]; hls: { prefix: string } | null };

function journalJob(job: Job) {
	const record: JournaledJob = {
		version: 2,
		id: job.id,
		request: job.request,
		key: job.key,
		uploadId: job.uploadId,
		t: job.t,
		fps: job.fps,
		bpp: job.bpp,
		resolution: job.resolution,
		totalFrames: job.totalFrames,
		totalSamples: job.totalSamples,
		width: job.width,
		height: job.height,
		chunks: job.chunks,
		sections: job.sections,
		plan: job.plan,
		probe: job.probe,
		tasks: [...job.tasks.values()]
			.filter((state) => !state.duplicateOf)
			.map((state) => state.task),
		hls: job.hls ? { prefix: job.hls.prefix } : null,
	};
	return journalPut(journalKey(job.id, "job.json"), JSON.stringify(record));
}

function audioFrame(meta: AudioResultMeta, data: Uint8Array) {
	const json = new TextEncoder().encode(JSON.stringify(meta));
	const body = new Uint8Array(4 + json.byteLength + data.byteLength);
	new DataView(body.buffer).setUint32(0, json.byteLength);
	body.set(json, 4);
	body.set(data, 4 + json.byteLength);
	return body;
}

async function newHlsState(prefix: string): Promise<HlsState> {
	return {
		prefix,
		url: await s3.presignFresh("GET", `${prefix}/index.m3u8`, 6 * 3600),
		segments: new Map(),
		listed: [],
		cursor: { chunk: 0, index: 0 },
		writing: false,
		dirty: false,
		ended: false,
	};
}

/**
 * The segments a worker published for a finished chunk, re-derived from its
 * keyframes with the worker's own cut rule (a segment closes at the first
 * GOP boundary at or past `segmentFrames`), so the playlist can be rebuilt.
 */
function segmentsFromResult(
	job: Job,
	chunk: Chunk,
	result: VideoResult,
): SegmentReport[] {
	if (!job.hls) return [];
	// Parts are numbered from the dispatch's first part, which names its segments.
	const firstPart = Math.min(...result.parts.map((part) => part.partNumber));
	const cuts = segmentCuts(
		result.keyframes,
		result.sizes.length,
		Math.round(job.fps * HLS_SEGMENT_SECONDS),
	);
	return cuts.map(([a, b], index) => ({
		chunk: chunk.index,
		index,
		frames: [chunk.frames[0] + a, chunk.frames[0] + b],
		key: segmentKey(job.hls?.prefix ?? "", chunk.index, firstPart, index),
		last: index === cuts.length - 1,
		extradata: result.extradata,
	}));
}

async function resumeJobs() {
	if (!JOURNAL) return;
	const keys = await s3.list("jobs/");
	const byJob = new Map<string, Set<string>>();
	for (const { key } of keys) {
		const [, id, ...rest] = key.split("/");
		if (!id) continue;
		const names = byJob.get(id) ?? new Set<string>();
		names.add(rest.join("/"));
		byJob.set(id, names);
	}
	for (const [id, names] of byJob) {
		if (names.has("done") || jobs.has(id)) continue;
		try {
			if (!names.has("job.json")) {
				if (!names.has("request.json")) continue;
				const receipt = JSON.parse(
					new TextDecoder().decode(
						await s3.get(journalKey(id, "request.json")),
					),
				) as { request: JobRequest; requestedAt: number };
				if (Date.now() - receipt.requestedAt > 5 * 3600_000) {
					await journalPut(journalKey(id, "done"), "expired");
					continue;
				}
				const job = await newJob(id, receipt.request, receipt.requestedAt);
				jobs.set(id, job);
				planJob(job).catch((error) => failJob(job, error));
				continue;
			}
			const record = JSON.parse(
				new TextDecoder().decode(await s3.get(journalKey(id, "job.json"))),
			) as JournaledJob;
			// Presigned segment/playlist URLs last 6 h; older jobs are abandoned.
			if (Date.now() - (record.t.requested ?? 0) > 5 * 3600_000) {
				await journalPut(journalKey(id, "done"), "expired");
				continue;
			}
			if (record.version !== 2) {
				if (record.uploadId)
					await s3.abortMultipart(record.key, record.uploadId);
				await journalPut(
					journalKey(id, "done"),
					"incompatible journal version",
				);
				console.error(
					`job ${id}: legacy journal has no durable upload reservations`,
				);
				continue;
			}
			const reservations: {
				task: Task;
				worker: string;
				duplicateOf?: string;
			}[] = [];
			const job: Job = {
				...record,
				acceptances: new Map(),
				status: "rendering",
				tasks: new Map(),
				videoResults: new Map(),
				audioSections: new Map(),
				audioWaiters: [],
				cpuSeconds: 0,
				fetchedBytes: 0,
				workersUsed: new Set(),
				waiters: [],
				taskStats: [],
				hls: record.hls ? await newHlsState(record.hls.prefix) : undefined,
			};
			job.t.resumed = now();
			job.t.lastProgress = now();
			for (const name of names) {
				const dispatch = name.match(/^dispatches\/(\d+)\/(\d+)\.json$/);
				if (dispatch) {
					const chunk = job.chunks[Number(dispatch[1])];
					if (!chunk) throw new Error("invalid reserved chunk");
					chunk.dispatches = Math.max(
						chunk.dispatches,
						Number(dispatch[2]) + 1,
					);
					reservations.push(
						JSON.parse(
							new TextDecoder().decode(await s3.get(journalKey(id, name))),
						),
					);
					continue;
				}
				const video = name.match(/^v\/(\d+)\.json$/);
				if (video) {
					const result = JSON.parse(
						new TextDecoder().decode(await s3.get(journalKey(id, name))),
					) as VideoResult;
					job.videoResults.set(Number(video[1]), result);
					continue;
				}
				const audio = name.match(/^a\/(\d+)\.bin$/);
				if (audio) {
					const bytes = await s3.get(journalKey(id, name));
					const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(
						0,
					);
					const meta = JSON.parse(
						new TextDecoder().decode(bytes.subarray(4, 4 + length)),
					) as AudioResultMeta;
					job.audioSections.set(Number(audio[1]), {
						meta,
						data: bytes.slice(4 + length),
					});
				}
			}
			jobs.set(id, job);
			let requeued = 0;
			for (const task of record.tasks) {
				const done =
					task.kind === "video"
						? job.videoResults.has(task.chunk)
						: job.audioSections.has(task.section);
				const state: TaskState = {
					task,
					state: done ? "done" : "queued",
					attempts: 0,
					heldUntil: done ? undefined : Date.now() + RESUME_HOLD_MS,
				};
				job.tasks.set(task.taskId, state);
				if (!done) {
					queue.push(state);
					requeued++;
				}
			}
			for (const reservation of reservations) {
				const { task, worker, duplicateOf } = reservation;
				let state = job.tasks.get(task.taskId);
				if (!state) {
					const done =
						task.kind === "video" && job.videoResults.has(task.chunk);
					state = {
						task,
						state: done ? "done" : "queued",
						attempts: 0,
						duplicateOf,
						heldUntil: done ? undefined : Date.now() + RESUME_HOLD_MS,
					};
					job.tasks.set(task.taskId, state);
					if (!done) queue.push(state);
				}
				if ((task.attempt ?? 0) >= state.attempts) {
					state.attempts = task.attempt ?? 0;
					state.worker = worker;
					state.reattach = true;
					if (task.kind === "video") state.firstPart = task.upload.firstPart;
				}
				if (duplicateOf) {
					const original = job.tasks.get(duplicateOf);
					if (original) original.duplicated = true;
				}
			}
			for (const chunk of job.chunks) {
				chunk.dispatches = Math.max(chunk.dispatches, 1);
			}
			// A first dispatch has no reservation of its own: any worker still
			// rendering it may re-attach it as attempt 1.
			for (const state of job.tasks.values()) {
				if (
					state.task.kind === "video" &&
					state.state === "queued" &&
					!state.duplicateOf &&
					!state.reattach
				) {
					state.attempts = 1;
					state.reattach = true;
					state.firstPart = job.chunks[state.task.chunk]?.firstPart;
				}
			}
			if (job.hls) {
				job.hls.audioExtradata = job.audioSections
					.values()
					.next().value?.meta.extradata;
				for (const chunk of job.chunks) {
					const result = job.videoResults.get(chunk.index);
					if (!result) continue;
					job.hls.extradata ??= result.extradata;
					job.hls.segments.set(
						chunk.index,
						new Map(
							segmentsFromResult(job, chunk, result).map((segment) => [
								segment.index,
								segment,
							]),
						),
					);
				}
				publishPlaylist(job);
			}
			console.log(
				`resumed job ${id}: ${job.videoResults.size}/${job.chunks.length} chunks, ${job.audioSections.size}/${job.sections.length} audio done, ${requeued} tasks held for re-attach`,
			);
			setTimeout(dispatch, RESUME_HOLD_MS + 50);
			if (audioReady(job)) job.t.audioDone ??= now();
			if (job.videoResults.size === job.chunks.length)
				job.t.videoDone ??= now();
			maybeAssemble(job);
		} catch (error) {
			console.error(`resume ${id} failed: ${error}`);
		}
	}
	dispatch();
}

// ---------------------------------------------------------------- dispatch ---

function enqueue(job: Job, task: Task, duplicateOf?: string) {
	const state: TaskState = { task, state: "queued", attempts: 0, duplicateOf };
	job.tasks.set(task.taskId, state);
	queue.push(state);
}

function pickQueued(accepts: (kind: string) => boolean) {
	for (const state of [...queue]) {
		const job = jobs.get(state.task.jobId);
		if (job && taskAccepted(job, state.task)) retireTask(state);
	}
	const schedulable = [...jobs.values()].map((job) => {
		let runningTasks = 0;
		for (const state of job.tasks.values()) {
			if (state.state === "running") runningTasks++;
		}
		return {
			id: job.id,
			status: job.status,
			requestedAt: job.t.requested ?? 0,
			chunks: job.chunks.map((chunk) => chunk.index),
			finishedChunks: job.videoResults,
			runningTasks,
		};
	});
	return pickQueuedTask(queue, schedulable, accepts, {
		headChunks: HEAD_CHUNKS,
		fifo: process.env.RF_SCHEDULER === "fifo",
		now: Date.now(),
	});
}

/** The task as sent for this attempt: its attempt number and part range. */
async function dispatchedTask(
	job: Job | undefined,
	state: TaskState,
): Promise<Task> {
	const task = state.task;
	if (task.kind !== "video" || !job)
		return { ...task, attempt: state.attempts };
	const chunk = job.chunks[task.chunk];
	if (!chunk) throw new Error("unknown chunk");
	const { range, firstPart } = reservePartRange(chunk);
	const dispatched = {
		...task,
		attempt: state.attempts,
		upload: { ...task.upload, firstPart, partLimit: chunk.partLimit },
	};
	// The journaled plan already reserves every chunk's first range (a resumed
	// coordinator never reuses it), so first dispatches skip this write; it
	// cost ~1 s of time to first segment on long exports.
	state.firstPart = firstPart;
	if (range === 0) return dispatched;
	await journalPut(
		journalKey(job.id, `dispatches/${chunk.index}/${range}.json`),
		JSON.stringify({
			task: dispatched,
			worker: state.worker,
			duplicateOf: state.duplicateOf,
		}),
	);
	return dispatched;
}

function taskAccepted(job: Job, task: Task) {
	return task.kind === "video"
		? job.videoResults.has(task.chunk)
		: job.audioSections.has(task.section);
}

function retireTask(state: TaskState) {
	state.state = "done";
	const index = queue.indexOf(state);
	if (index >= 0) queue.splice(index, 1);
}

/** Put a task back in the queue, at most once. */
function requeue(state: TaskState, reason: string) {
	const job = jobs.get(state.task.jobId);
	if (!job || job.status !== "rendering" || taskAccepted(job, state.task)) {
		retireTask(state);
		return;
	}
	console.warn(`requeue ${state.task.taskId}: ${reason}`);
	state.state = "queued";
	state.worker = undefined;
	state.progress = undefined;
	state.reattach = false;
	if (!queue.includes(state)) queue.unshift(state);
}

function dispatch() {
	pumpLocalAudio();
	for (let p = 0; p < pollers.length; ) {
		const poller = pollers[p] as Poller;
		const accepts = (kind: string) =>
			!poller.kinds || poller.kinds.includes(kind);
		const next = pickQueued(accepts);
		let state: TaskState | undefined;
		if (next >= 0) {
			state = queue.splice(next, 1)[0];
		} else if (accepts("video") && !poller.prefetch) {
			state = straggler();
		}
		if (!state) {
			p++;
			continue;
		}
		pollers.splice(p, 1);
		state.prefetched = poller.prefetch;
		state.progress = undefined;
		state.state = "running";
		state.worker = poller.worker;
		state.startedAt = now();
		state.attempts++;
		state.lastReportedAt = undefined;
		const job = jobs.get(state.task.jobId);
		if (job) {
			job.t.firstTaskStarted ??= now();
			if (state.task.kind === "video") job.t.firstVideoStarted ??= now();
			job.workersUsed.add(poller.worker);
		}
		state.dispatching = true;
		state.reattach = false;
		const dispatchedState = state;
		dispatchedTask(job, state).then(
			(task) => {
				dispatchedState.dispatching = false;
				dispatchedState.startedAt = now();
				poller.resolve(job?.status === "rendering" ? task : null);
			},
			(error) => {
				dispatchedState.dispatching = false;
				if (job) failJob(job, error);
				poller.resolve(null);
			},
		);
	}
}

/**
 * Speculative execution: once the queue has drained, hedge the running chunk
 * whose projected finish is furthest behind what a fresh slot could do. Slow
 * replicas (noisy neighbours) otherwise set the whole export's tail.
 */
const FROZEN_MS = 5_000;

function straggler(): TaskState | undefined {
	let best: { state: TaskState; gain: number } | undefined;
	for (const job of jobs.values()) {
		if (job.status !== "rendering" || job.request.duplicateStragglers === false)
			continue;
		const rates = job.taskStats
			.filter(
				(stat) => stat.kind === "video" && Number(stat.engineRenderMs) > 0,
			)
			.map((stat) => Number(stat.frames) / Number(stat.engineRenderMs));
		for (const state of job.tasks.values()) {
			if (state.state !== "running" || state.task.kind !== "video") continue;
			const frames = state.progress?.frames ?? 0;
			if (frames > 0)
				rates.push(frames / Math.max(1, state.progress?.elapsedMs ?? 1));
		}
		if (rates.length < 3) continue;
		rates.sort((a, b) => a - b);
		const typicalRate = rates[Math.floor(rates.length / 2)] ?? 0;
		if (typicalRate <= 0) continue;
		for (const state of job.tasks.values()) {
			if (
				state.task.kind !== "video" ||
				state.dispatching ||
				state.state !== "running" ||
				state.duplicated ||
				state.duplicateOf ||
				(state.prefetched && !state.progress) ||
				job.videoResults.has(state.task.chunk)
			) {
				continue;
			}
			const total = state.task.frames[1] - state.task.frames[0];
			const elapsed =
				state.progress?.elapsedMs ?? now() - (state.startedAt ?? now());
			const frames = state.progress?.frames ?? 0;
			const expected = total / typicalRate + 2500;
			// Engines report frames several times a second. A copy part-way
			// through whose count stopped is hung: projecting from its average
			// rate hedged one frozen near its end only when the engine watchdog
			// fired, 30 s later.
			const frozen =
				frames > 0 &&
				frames < total &&
				now() - (state.progress?.advancedAt ?? now()) > FROZEN_MS;
			// A copy with no frames long past its expected time is stuck (not
			// merely slow): its remaining time is unknown, so always hedge it.
			const remaining = frozen
				? Number.POSITIVE_INFINITY
				: frames > 0
					? ((total - frames) * (state.progress?.elapsedMs ?? elapsed)) / frames
					: elapsed > expected * 2
						? Number.POSITIVE_INFINITY
						: Math.max(0, expected - elapsed) * 2;
			const fresh = 2500 + total / typicalRate;
			const gain = remaining - fresh;
			if (gain > 3000 && (!best || gain > best.gain)) best = { state, gain };
		}
	}
	if (!best || best.state.task.kind !== "video") return undefined;
	best.state.duplicated = true;
	const job = jobs.get(best.state.task.jobId);
	if (!job) return undefined;
	const original = best.state.task;
	const task: VideoTask = { ...original, taskId: `${original.taskId}:dup` };
	const state: TaskState = {
		task,
		state: "queued",
		attempts: 0,
		duplicateOf: best.state.task.taskId,
	};
	job.tasks.set(task.taskId, state);
	return state;
}

/** Running tasks whose result is already in (hedge losers) or whose job ended. */
function cancellations(worker: string) {
	const out: string[] = [];
	for (const job of jobs.values()) {
		const ended = job.status !== "rendering";
		if (ended && Date.now() - (job.t.ready ?? job.t.failed ?? now()) > 120_000)
			continue;
		for (const state of job.tasks.values()) {
			if (state.state !== "running" || state.worker !== worker) continue;
			if (
				ended ||
				(state.task.kind === "video" && job.videoResults.has(state.task.chunk))
			) {
				out.push(state.task.taskId);
			}
		}
	}
	return out;
}

/**
 * A worker process restarted on the same host (crash, app hot-swap): its old
 * id is dead, so hand its tasks back now instead of waiting for the timeout.
 */
function supersede(id: string) {
	const host = id.slice(0, id.lastIndexOf("-"));
	// Only predecessors that have gone quiet: two live workers sharing a
	// hostname (several GPUs on one host) must not evict each other.
	const quietSince = Date.now() - 4_500;
	for (const [old, worker] of [...workers.entries()]) {
		if (old === id || old.slice(0, old.lastIndexOf("-")) !== host) continue;
		if (worker.lastSeen > quietSince) continue;
		workers.delete(old);
		for (const job of jobs.values()) {
			if (job.status !== "rendering") continue;
			for (const state of job.tasks.values()) {
				if (
					state.state === "running" &&
					!state.dispatching &&
					state.worker === old
				) {
					requeue(state, `worker ${old} restarted`);
				}
			}
		}
	}
}

setInterval(() => {
	// Requeue work held by workers that stopped heartbeating (they beat every
	// 3 s). Local audio lanes run in this process and never heartbeat.
	const cutoff = Date.now() - 12_000;
	for (const job of jobs.values()) {
		if (job.status !== "rendering") continue;
		const lastProgress = job.t.lastProgress ?? job.t.planned ?? now();
		if (now() - lastProgress > JOB_STALL_MS) {
			failJob(
				job,
				new Error(
					`no progress for ${Math.round((now() - lastProgress) / 1000)} s`,
				),
			);
			continue;
		}
		for (const state of job.tasks.values()) {
			if (
				state.state !== "running" ||
				state.dispatching ||
				!state.worker ||
				state.worker === "coordinator"
			)
				continue;
			const worker = workers.get(state.worker);
			if (!worker || worker.lastSeen < cutoff) {
				requeue(state, `worker ${state.worker} went away`);
				continue;
			}
			// A live worker that stops listing a task (lost /work response,
			// crashed slot) no longer holds it.
			if ((state.lastReportedAt ?? state.startedAt ?? 0) < cutoff) {
				requeue(state, `not reported by ${state.worker}`);
			}
		}
	}
	dispatch();
}, 5_000);

// ---------------------------------------------------------------- results ---

function failJob(job: Job, error: unknown) {
	if (job.status === "error" || job.status === "ready") return;
	job.status = "error";
	job.error = error instanceof Error ? error.message : String(error);
	job.t.failed = now();
	console.error(`job ${job.id} failed: ${job.error}`);
	for (const state of job.tasks.values()) {
		const index = queue.indexOf(state);
		if (index >= 0) queue.splice(index, 1);
	}
	if (job.uploadId) s3.abortMultipart(job.key, job.uploadId).catch(() => {});
	finish(job);
}

async function writeInit(job: Job, hls: HlsState) {
	if (!hls.extradata) return false;
	let asc: Uint8Array | null = null;
	if (job.sections.length > 0) {
		if (!hls.audioExtradata) return false;
		asc = Buffer.from(hls.audioExtradata, "base64");
	}
	const key = `${hls.prefix}/init.mp4`;
	await s3.put(
		key,
		initSegment({
			width: job.width,
			height: job.height,
			fps: job.fps,
			avcC: avcC(Buffer.from(hls.extradata, "base64")),
			asc,
		}),
		"video/mp4",
	);
	hls.initUrl = await s3.presignFresh("GET", key, 6 * 3600);
	return true;
}

/** Rewrites the playlist whenever the contiguous run of segments grows. */
async function publishPlaylist(job: Job) {
	const hls = job.hls;
	if (!hls || hls.ended || job.status === "error") return;
	clearTimeout(hls.retry);
	if (hls.writing) {
		hls.dirty = true;
		return;
	}
	hls.writing = true;
	try {
		do {
			hls.dirty = false;
			if (!hls.initUrl && !(await writeInit(job, hls))) return;
			let grew = false;
			let cursor = { ...hls.cursor };
			const listed = [...hls.listed];
			for (;;) {
				const segment = hls.segments.get(cursor.chunk)?.get(cursor.index);
				if (!segment) break;
				listed.push({
					url: await s3.presignFresh("GET", segment.key, 6 * 3600),
					duration: (segment.frames[1] - segment.frames[0]) / job.fps,
				});
				grew = true;
				cursor = segment.last
					? { chunk: cursor.chunk + 1, index: 0 }
					: { chunk: cursor.chunk, index: cursor.index + 1 };
			}
			const ended = cursor.chunk >= job.chunks.length;
			if (!grew && !ended) continue;
			await s3.put(
				`${hls.prefix}/index.m3u8`,
				playlist(listed, {
					initUrl: hls.initUrl as string,
					targetDuration: HLS_SEGMENT_SECONDS + 2,
					ended,
				}),
				"application/vnd.apple.mpegurl",
			);
			hls.cursor = cursor;
			hls.listed = listed;
			if (hls.listed.length > 0) job.t.firstSegment ??= now();
			if (ended) {
				hls.ended = true;
				job.t.hlsEnded = now();
				if (job.status === "ready") persistFinished(job);
			}
		} while (hls.dirty && !hls.ended);
	} catch (error) {
		console.error(`job ${job.id} playlist: ${error}`);
		if (now() - (job.t.requested ?? 0) < 5 * 3600_000) {
			hls.retry = setTimeout(() => publishPlaylist(job), 1000);
			hls.retry.unref();
		}
	} finally {
		hls.writing = false;
	}
}

function persistFinished(job: Job) {
	journalPut(journalKey(job.id, "done"), job.status).catch((error) => {
		console.error(`job ${job.id} terminal journal: ${error}`);
		if (jobs.has(job.id)) setTimeout(() => persistFinished(job), 1000).unref();
	});
}

function finish(job: Job) {
	if (job.status === "error" || !job.hls || job.hls.ended) persistFinished(job);
	job.audioCache?.close();
	// Freeze the summary, then drop the media: rendered audio alone is ~290 MB
	// for a 2 h export, and finished jobs were never evicted.
	job.final = summary(job);
	job.audioSections.clear();
	job.videoResults.clear();
	job.taskStats = [];
	for (const [taskId, state] of job.tasks) {
		const index = queue.indexOf(state);
		if (index >= 0) queue.splice(index, 1);
		// Running copies stay so their workers are told to cancel them.
		if (state.state !== "running") job.tasks.delete(taskId);
	}
	setTimeout(() => jobs.delete(job.id), JOB_RETENTION_MS).unref();
	for (const waiter of job.waiters.splice(0)) waiter();
	for (const waiter of job.audioWaiters.splice(0)) waiter();
	finishedJobs.push(job.id);
	if (finishedJobs.length > 50) finishedJobs.shift();
	rmSync(join(WORK_DIR, job.id), { recursive: true, force: true });
}

function recordStat(
	job: Job,
	kind: string,
	index: number,
	worker: string,
	timings: object,
) {
	job.taskStats.push({ kind, index, worker, ...timings });
}

async function onVideoDone(job: Job, state: TaskState, result: VideoResult) {
	if (state.task.kind !== "video") return Promise.resolve();
	await acceptOnce(job.acceptances, `v/${state.task.chunk}`, () =>
		acceptVideo(job, state, result),
	);
	retireTask(state);
}

async function acceptVideo(job: Job, state: TaskState, result: VideoResult) {
	if (state.task.kind !== "video") return;
	const chunk = state.task.chunk;
	if (job.videoResults.has(chunk) || job.status !== "rendering") return;
	await journalPut(
		journalKey(job.id, `v/${chunk}.json`),
		JSON.stringify(result),
	);
	if (job.status !== "rendering") return;
	state.state = "done";
	const queued = queue.indexOf(state);
	if (queued >= 0) queue.splice(queued, 1);
	recordStat(job, "video", chunk, result.worker, {
		...result.timings,
		fetchBytes: result.timings.fetch.bytes,
		fetchMs: result.timings.fetch.ms,
		engineRenderMs: result.timings.engine.render_ms,
		frames: result.sizes.length,
		bytes: result.bytes,
		duplicate: Boolean(state.duplicateOf),
	});
	job.cpuSeconds += result.timings.cpuSeconds;
	job.fetchedBytes += result.timings.fetch.bytes;

	for (const other of job.tasks.values()) {
		// The sibling copy (original or hedge) is now redundant.
		if (
			other !== state &&
			other.task.kind === "video" &&
			other.task.chunk === chunk &&
			other.state === "queued"
		) {
			other.state = "done";
			const index = queue.indexOf(other);
			if (index >= 0) queue.splice(index, 1);
		}
	}
	job.videoResults.set(chunk, result);
	job.t.lastProgress = now();
	// Segments reported to a previous coordinator process (before a restart)
	// are not reported again; derive any missing ones from the result.
	const chunkPlan = job.chunks[chunk];
	if (job.hls && chunkPlan) {
		job.hls.extradata ??= result.extradata;
		const known =
			job.hls.segments.get(chunk) ?? new Map<number, SegmentReport>();
		for (const segment of segmentsFromResult(job, chunkPlan, result)) {
			if (!known.has(segment.index)) known.set(segment.index, segment);
		}
		job.hls.segments.set(chunk, known);
		publishPlaylist(job);
	}
	if (job.videoResults.size === job.chunks.length) {
		job.t.videoDone = now();
		maybeAssemble(job);
	}
}

async function onAudioDone(
	job: Job,
	state: TaskState,
	meta: AudioResultMeta,
	data: Uint8Array,
) {
	if (state.task.kind !== "audio") return Promise.resolve();
	await acceptOnce(job.acceptances, `a/${state.task.section}`, () =>
		acceptAudio(job, state, meta, data),
	);
	retireTask(state);
}

async function acceptAudio(
	job: Job,
	state: TaskState,
	meta: AudioResultMeta,
	data: Uint8Array,
) {
	if (
		state.task.kind !== "audio" ||
		job.status !== "rendering" ||
		job.audioSections.has(state.task.section)
	)
		return;
	await journalPut(
		journalKey(job.id, `a/${state.task.section}.bin`),
		audioFrame(meta, data),
	);
	if (job.status !== "rendering") return;
	state.state = "done";
	const queued = queue.indexOf(state);
	if (queued >= 0) queue.splice(queued, 1);
	if (job.hls) job.hls.audioExtradata ??= meta.extradata;
	job.audioSections.set(state.task.section, { meta, data });
	job.t.lastProgress = now();
	if (job.hls && !job.hls.initUrl) publishPlaylist(job);
	recordStat(job, "audio", state.task.section, meta.worker, {
		...meta.timings,
		fetchMs: meta.timings.fetch.ms,
		fetchBytes: meta.timings.fetch.bytes,
	});
	job.cpuSeconds += meta.timings.cpuSeconds;
	job.fetchedBytes += meta.timings.fetch.bytes;
	if (audioReady(job)) job.t.audioDone = now();
	for (const waiter of job.audioWaiters.splice(0)) waiter();
	if (audioReady(job)) maybeAssemble(job);
}

function audioReady(job: Job) {
	return job.audioSections.size === job.sections.length;
}

function maybeAssemble(job: Job) {
	if (job.status !== "rendering") return;
	if (job.videoResults.size !== job.chunks.length || !audioReady(job)) return;
	job.status = "assembling";
	assemble(job).catch((error) => failJob(job, error));
}

async function assemble(job: Job) {
	const results = job.chunks.map((chunk) => {
		const result = job.videoResults.get(chunk.index);
		if (!result) throw new Error(`missing chunk ${chunk.index}`);
		return result;
	});
	const extradata = results[0]?.extradata ?? "";
	for (const result of results) {
		if (result.extradata !== extradata) {
			throw new Error("chunks disagree on SPS/PPS; cannot join them");
		}
	}
	const sizes = new Uint32Array(job.totalFrames);
	const keyframes: number[] = [];
	const videoRuns: Run[] = [];
	const audioRuns: Run[] = [];
	const parts: { partNumber: number; etag: string }[] = [];
	let base = 0;
	job.chunks.forEach((chunk, index) => {
		const result = results[index] as VideoResult;
		sizes.set(result.sizes, chunk.frames[0]);
		for (const key of result.keyframes) keyframes.push(chunk.frames[0] + key);
		for (const run of result.videoRuns)
			videoRuns.push({ ...run, offset: run.offset + base });
		for (const run of result.audioRuns)
			audioRuns.push({ ...run, offset: run.offset + base });
		for (const part of result.parts) parts.push(part);
		base += result.bytes + result.paddedBytes;
	});
	const payloadSize = base;

	let audio: Parameters<typeof buildHeader>[0]["audio"] = null;
	if (job.sections.length > 0) {
		const totalPackets = Math.ceil(job.totalSamples / PACKET) + 1;
		const audioSizes = new Uint32Array(totalPackets);
		let asc = "";
		for (const { meta } of job.audioSections.values()) {
			audioSizes.set(meta.sizes, meta.firstPacket);
			asc = meta.extradata;
		}
		audio = {
			sizes: audioSizes,
			runs: audioRuns,
			asc: Buffer.from(asc, "base64"),
			totalSamples: job.totalSamples,
			priming: PACKET,
		};
		const covered = audioRuns.reduce((sum, run) => sum + run.count, 0);
		if (covered !== totalPackets) {
			throw new Error(`audio runs cover ${covered}/${totalPackets} packets`);
		}
	}
	const videoCovered = videoRuns.reduce((sum, run) => sum + run.count, 0);
	if (videoCovered !== job.totalFrames) {
		throw new Error(
			`video runs cover ${videoCovered}/${job.totalFrames} frames`,
		);
	}

	const header = buildHeader({
		width: results[0]?.width ?? job.width,
		height: results[0]?.height ?? job.height,
		fps: job.fps,
		video: {
			sizes,
			runs: videoRuns,
			keyframes: Uint32Array.from(keyframes),
			avcC: avcC(Buffer.from(extradata, "base64")),
		},
		audio,
		payloadSize,
		minimumSize: MIN_PART + 64 * 1024,
	});
	job.t.headerBuilt = now();
	if (!job.uploadId) throw new Error("no upload");
	job.outputBytes = await completeUpload(
		s3,
		{
			key: job.key,
			uploadId: job.uploadId,
			header,
			payloadSize,
			parts,
		},
		(intent) => journalPut(journalKey(job.id, "assembly.json"), intent),
	);
	job.t.completed = now();

	await s3.ready();
	job.url = await s3.presignFresh("GET", job.key, 24 * 3600);
	if (process.env.RF_VERIFY_ASYNC !== "0") {
		// Watchable as soon as the object exists; the ffprobe check still
		// runs and is reported on the job, it just isn't on the user's path.
		verifyPlayable(job).then(
			() => {
				job.verified = true;
			},
			(error) => {
				job.verified = false;
				console.error(`job ${job.id} FAILED verification: ${error}`);
			},
		);
	} else {
		await verifyPlayable(job);
		job.verified = true;
	}
	job.t.ready = now();
	job.status = "ready";
	console.log(
		`job ${job.id} ready in ${Math.round(job.t.ready - (job.t.requested ?? 0))}ms (${job.chunks.length} chunks)`,
	);
	finish(job);
}

async function verifyPlayable(job: Job) {
	if (!job.url) return;
	const probe = Bun.spawn(
		[
			"ffprobe",
			"-v",
			"error",
			"-show_entries",
			"format=duration:stream=codec_name,nb_frames",
			"-of",
			"json",
			job.url,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [out, err, code] = await Promise.all([
		new Response(probe.stdout).text(),
		new Response(probe.stderr).text(),
		probe.exited,
	]);
	if (code !== 0) throw new Error(`ffprobe failed: ${err.slice(0, 300)}`);
	const parsed = JSON.parse(out) as {
		format?: { duration?: string };
		streams?: { codec_name?: string; nb_frames?: string }[];
	};
	const duration = Number(parsed.format?.duration ?? 0);
	const expected = job.totalFrames / job.fps;
	if (Math.abs(duration - expected) > 0.5) {
		throw new Error(`output duration ${duration}s, expected ${expected}s`);
	}
	const frames = Number(
		parsed.streams?.find((stream) => stream.codec_name === "h264")?.nb_frames ??
			0,
	);
	if (frames !== job.totalFrames) {
		throw new Error(`output has ${frames} frames, expected ${job.totalFrames}`);
	}
}

// ---------------------------------------------------------------- summary ---

function percentile(values: number[], p: number) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
	);
}

function summary(job: Job) {
	const start = job.t.requested ?? 0;
	const rel = Object.fromEntries(
		Object.entries(job.t).map(([name, value]) => [
			name,
			Math.round(value - start),
		]),
	);
	const video = job.taskStats.filter(
		(stat) => stat.kind === "video" && !stat.duplicate,
	);
	const audio = job.taskStats.filter((stat) => stat.kind === "audio");
	const pick = (list: Record<string, unknown>[], field: string) =>
		list.map((stat) => Number(stat[field] ?? 0));
	const describe = (list: Record<string, unknown>[], field: string) => ({
		p50: Math.round(percentile(pick(list, field), 0.5)),
		p95: Math.round(percentile(pick(list, field), 0.95)),
		max: Math.round(Math.max(0, ...pick(list, field))),
	});
	return {
		id: job.id,
		label: job.request.label,
		status: job.status,
		error: job.error,
		recording: job.request.recording,
		fps: job.fps,
		resolution: job.resolution,
		output: {
			width: job.width,
			height: job.height,
			frames: job.totalFrames,
			bytes: job.outputBytes,
		},
		url: job.status === "ready" ? job.url : undefined,
		timeline: rel,
		plan: job.plan,
		probe: job.probe,
		workersUsed: job.workersUsed.size,
		verified: job.verified,
		hlsUrl: job.hls?.url,
		hlsSegments: job.hls?.listed.length,
		cpuSeconds: Math.round(job.cpuSeconds * 10) / 10,
		fetchedBytes: job.fetchedBytes,
		duplicates: job.taskStats.filter((stat) => stat.duplicate).length,
		video: {
			total: describe(video, "totalMs"),
			fetch: describe(video, "fetchMs"),
			render: describe(video, "engineRenderMs"),
			engine: describe(video, "engineMs"),
			audioWait: describe(video, "audioWaitMs"),
			upload: describe(video, "uploadMs"),
			queued: describe(video, "queuedMs"),
		},
		audio: {
			total: describe(audio, "totalMs"),
			engine: describe(audio, "engineMs"),
			fetch: describe(audio, "fetchMs"),
		},
		tasks: job.taskStats,
	};
}

// ------------------------------------------------------------------ server ---

function authorized(request: Request) {
	if (!TOKEN) return true;
	const given = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${TOKEN}`);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

Bun.serve({
	port: PORT,
	hostname: "::",
	idleTimeout: 120,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/health")
			return Response.json({ ok: true, ...liveSlots() });
		if (!authorized(request))
			return new Response("unauthorized", { status: 401 });

		if (url.pathname === "/work" && request.method === "POST") {
			const body = (await request.json()) as {
				worker: string;
				slots: number;
				cpus: number;
				service?: string;
				kinds?: string[];
				audioSlots?: number;
				prefetch?: boolean;
				draining?: boolean;
			};
			const worker = workers.get(body.worker) ?? {
				id: body.worker,
				slots: body.slots,
				cpus: body.cpus,
				lastSeen: Date.now(),
				service: body.service ?? "",
			};
			worker.lastSeen = Date.now();
			worker.slots = body.slots;
			worker.audioSlots = body.audioSlots ?? 0;
			supersede(body.worker);
			workers.set(body.worker, worker);
			if (body.draining)
				return Response.json({ task: null, finished: finishedJobs });
			const task = await new Promise<Task | null>((resolve) => {
				const poller: Poller = {
					worker: body.worker,
					kinds: body.kinds,
					prefetch: body.prefetch,
					resolve,
				};
				pollers.push(poller);
				dispatch();
				if (poller.prefetch) {
					const index = pollers.indexOf(poller);
					if (index >= 0) {
						pollers.splice(index, 1);
						resolve(null);
					}
				}
				setTimeout(() => {
					const index = pollers.indexOf(poller);
					if (index >= 0) {
						pollers.splice(index, 1);
						resolve(null);
					}
				}, 20_000);
			});
			return Response.json({ task, finished: finishedJobs });
		}

		if (url.pathname === "/heartbeat" && request.method === "POST") {
			const body = (await request.json()) as {
				worker: string;
				slots: number;
				cpus: number;
				usage?: Usage | null;
				running?: {
					taskId: string;
					attempt?: number;
					phase?: "reserved" | "running";
					frames: number;
					total: number;
					elapsedMs: number;
				}[];
			};
			for (const entry of body.running ?? []) {
				const job = jobs.get(entry.taskId.split(":")[0] ?? "");
				const state = job?.tasks.get(entry.taskId);
				if (!state) continue;
				if (
					state.state === "queued" &&
					state.heldUntil &&
					(state.task.kind === "audio" ||
						(state.reattach &&
							(state.worker === undefined || state.worker === body.worker) &&
							state.attempts === entry.attempt))
				) {
					// Still running from before a coordinator restart: adopt it.
					state.state = "running";
					state.worker = body.worker;
					state.startedAt = now() - entry.elapsedMs;
					state.heldUntil = undefined;
					state.reattach = false;
					state.attempts = entry.attempt ?? 1;
					state.prefetched = entry.phase === "reserved";
					const index = queue.indexOf(state);
					if (index >= 0) queue.splice(index, 1);
					console.log(`re-attached ${entry.taskId} to ${body.worker}`);
				}
				if (
					state.state !== "running" ||
					state.worker !== body.worker ||
					(entry.attempt !== undefined && state.attempts !== entry.attempt)
				)
					continue;
				state.lastReportedAt = Date.now();
				if (entry.phase === "reserved") continue;
				if (state.task.kind === "video") {
					const advanced = entry.frames > (state.progress?.frames ?? 0);
					if (advanced && job) job.t.lastProgress = now();
					state.progress = {
						...entry,
						at: now(),
						advancedAt:
							advanced || !state.progress ? now() : state.progress.advancedAt,
					};
				}
			}
			const worker = workers.get(body.worker);
			supersede(body.worker);
			if (worker) {
				worker.lastSeen = Date.now();
				worker.usage = body.usage;
			} else {
				workers.set(body.worker, {
					id: body.worker,
					slots: body.slots,
					cpus: body.cpus,
					lastSeen: Date.now(),
					service: "",
					usage: body.usage,
				});
			}
			return Response.json({
				finished: finishedJobs,
				cancel: cancellations(body.worker),
			});
		}

		const segmentMatch = url.pathname.match(/^\/tasks\/([^/]+)\/segment$/);
		if (segmentMatch && request.method === "POST") {
			const taskId = decodeURIComponent(segmentMatch[1] ?? "");
			const job = jobs.get(taskId.split(":")[0] ?? "");
			if (!job?.hls) return new Response("unknown job", { status: 404 });
			const state = job.tasks.get(taskId);
			const plan =
				state?.task.kind === "video" ? job.chunks[state.task.chunk] : undefined;
			const report =
				plan && state?.firstPart !== undefined
					? checkSegmentReport(
							await request.json(),
							job.hls.prefix,
							plan,
							state.firstPart,
						)
					: null;
			if (!report) return new Response("invalid segment", { status: 400 });
			job.hls.extradata ??= report.extradata || undefined;
			let chunk = job.hls.segments.get(report.chunk);
			if (!chunk) {
				chunk = new Map();
				job.hls.segments.set(report.chunk, chunk);
			}
			// First copy wins; other copies wrote their own objects.
			if (!chunk.has(report.index)) chunk.set(report.index, report);
			publishPlaylist(job);
			return Response.json({ ok: true });
		}

		const taskMatch = url.pathname.match(
			/^\/tasks\/([^/]+)\/(done|fail|audio)$/,
		);
		if (taskMatch && request.method === "POST") {
			const taskId = decodeURIComponent(taskMatch[1] ?? "");
			const jobId = taskId.split(":")[0] ?? "";
			const job = jobs.get(jobId);
			const state = job?.tasks.get(taskId);
			if (!job || !state) return new Response("unknown task", { status: 404 });
			if (taskMatch[2] === "fail") {
				const body = (await request.json()) as {
					error: string;
					worker: string;
					attempt?: number;
				};
				console.warn(`task ${taskId} failed on ${body.worker}: ${body.error}`);
				if (job.status !== "rendering") return Response.json({ ok: true });
				// A stale copy (already requeued, re-dispatched or resumed) failing
				// says nothing about the attempt now in charge of the task.
				if (
					state.state !== "running" ||
					state.worker !== body.worker ||
					(body.attempt !== undefined && body.attempt !== state.attempts)
				) {
					return Response.json({ ok: true });
				}
				if (
					state.task.kind === "video" &&
					job.videoResults.has(state.task.chunk)
				) {
					state.state = "done";
					return Response.json({ ok: true });
				}
				if (state.duplicateOf) {
					state.state = "done";
					return Response.json({ ok: true });
				}
				if (state.attempts >= 5)
					failJob(job, new Error(`${taskId}: ${body.error}`));
				else {
					// Back off before retrying so a transient storage hiccup
					// can't burn every attempt within a second.
					state.state = "queued";
					state.worker = undefined;
					state.heldUntil = Date.now() + 1000 * state.attempts;
					if (!queue.includes(state)) queue.unshift(state);
					setTimeout(dispatch, 1000 * state.attempts + 50);
				}
				return Response.json({ ok: true });
			}
			if (taskMatch[2] === "done") {
				const result = (await request.json()) as VideoResult;
				if (job.status === "rendering") await onVideoDone(job, state, result);
				return Response.json({ ok: true });
			}
			// audio: [u32 json length][json][packet bytes]
			const bytes = new Uint8Array(await request.arrayBuffer());
			const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
			const meta = JSON.parse(
				new TextDecoder().decode(bytes.subarray(4, 4 + length)),
			) as AudioResultMeta;
			const data = bytes.slice(4 + length);
			if (state.task.kind === "audio" && job.status === "rendering") {
				await onAudioDone(job, state, meta, data);
			}
			return Response.json({ ok: true });
		}

		const audioMatch = url.pathname.match(/^\/jobs\/([^/]+)\/audio$/);
		if (audioMatch && request.method === "GET") {
			const job = jobs.get(audioMatch[1] ?? "");
			if (!job) return new Response("unknown job", { status: 404 });
			const from = Number(url.searchParams.get("from"));
			const to = Number(url.searchParams.get("to"));
			const collect = () => {
				const sizes: number[] = [];
				const pieces: Uint8Array[] = [];
				let packet = from;
				while (packet < to) {
					let found = false;
					for (const { meta, data } of job.audioSections.values()) {
						const end = meta.firstPacket + meta.sizes.length;
						if (packet < meta.firstPacket || packet >= end) continue;
						let offset = 0;
						for (let index = 0; index < packet - meta.firstPacket; index++) {
							offset += meta.sizes[index] ?? 0;
						}
						const last = Math.min(to, end);
						for (
							let index = packet - meta.firstPacket;
							index < last - meta.firstPacket;
							index++
						) {
							const size = meta.sizes[index] ?? 0;
							sizes.push(size);
							pieces.push(data.subarray(offset, offset + size));
							offset += size;
						}
						packet = last;
						found = true;
						break;
					}
					if (!found) return null;
				}
				return { sizes, pieces };
			};
			let collected = collect();
			while (!collected) {
				if (job.status !== "rendering" && job.status !== "planning")
					return new Response("job finished", { status: 410 });
				await new Promise<void>((resolve) => {
					job.audioWaiters.push(resolve);
					setTimeout(resolve, 10_000);
				});
				collected = collect();
			}
			const header = new Uint8Array(4 + collected.sizes.length * 4);
			const view = new DataView(header.buffer);
			view.setUint32(0, collected.sizes.length);
			for (const [index, size] of collected.sizes.entries()) {
				view.setUint32(4 + index * 4, size);
			}
			return new Response(
				new Blob([header, ...collected.pieces] as BlobPart[]),
			);
		}

		if (url.pathname === "/index" && request.method === "POST") {
			// Upload-time hook: index a recording's sources before any export.
			const parsed = validateJobRequest(await request.json().catch(() => null));
			if (typeof parsed === "string")
				return new Response(parsed, { status: 400 });
			const body = parsed;
			const started = performance.now();
			await sourceIndex(body.recording.replace(/\/$/, ""));
			return Response.json({ ms: Math.round(performance.now() - started) });
		}

		if (url.pathname === "/jobs" && request.method === "POST") {
			const parsed = validateJobRequest(await request.json().catch(() => null));
			if (typeof parsed === "string")
				return new Response(parsed, { status: 400 });
			const body = parsed;
			const active = [...jobs.values()].filter(
				(job) => job.status !== "ready" && job.status !== "error",
			).length;
			if (active >= MAX_ACTIVE_JOBS) {
				return new Response("too many active exports", {
					status: 429,
					headers: { "retry-after": "10" },
				});
			}
			const id = randomUUID().slice(0, 12);
			const job = await newJob(id, body);

			jobs.set(id, job);
			try {
				await journalPut(
					journalKey(id, "request.json"),
					JSON.stringify({
						id,
						request: body,
						requestedAt: job.t.requested,
					}),
				);
			} catch (error) {
				jobs.delete(id);
				throw error;
			}
			planJob(job).catch((error) => failJob(job, error));
			return Response.json({ id, hlsUrl: job.hls?.url });
		}

		const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)(\/wait)?$/);
		if (jobMatch && request.method === "GET") {
			const job = jobs.get(jobMatch[1] ?? "");
			if (!job) return new Response("unknown job", { status: 404 });
			if (jobMatch[2] && job.status !== "ready" && job.status !== "error") {
				await new Promise<void>((resolve) => {
					job.waiters.push(resolve);
					setTimeout(resolve, 100_000);
				});
			}
			const body = job.final
				? { ...job.final, verified: job.verified }
				: summary(job);
			// Re-signed per read: a URL issued at submission lapses with its
			// signature or the instance credentials behind it.
			if (job.hls) {
				body.hlsUrl = await s3.presignFresh(
					"GET",
					`${job.hls.prefix}/index.m3u8`,
					6 * 3600,
				);
			}
			return Response.json(body);
		}

		if (url.pathname === "/usage") {
			// Fleet totals for cost accounting: diff two snapshots around a job.
			const live = [...workers.values()].filter(
				(worker) => Date.now() - worker.lastSeen < 30_000,
			);
			return Response.json({
				at: Date.now(),
				workers: live.length,
				cpuSeconds: live.reduce(
					(sum, worker) => sum + (worker.usage?.cpuSeconds ?? 0),
					0,
				),
				memoryBytes: live.reduce(
					(sum, worker) => sum + (worker.usage?.memoryBytes ?? 0),
					0,
				),
				perWorker: live.map((worker) => ({ id: worker.id, ...worker.usage })),
			});
		}

		if (url.pathname === "/workers") {
			return Response.json({
				...liveSlots(),
				workers: [...workers.values()].map((worker) => ({
					...worker,
					ageMs: Date.now() - worker.lastSeen,
				})),
				queue: queue.length,
			});
		}

		return new Response("not found", { status: 404 });
	},
});

console.log(`render-farm coordinator on :${PORT} (${PUBLIC_URL})`);

// Pick up exports a previous coordinator process left unfinished.
resumeJobs().catch((error) => console.error(`resume failed: ${error}`));

export type { Job, TaskState };

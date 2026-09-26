import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { availableParallelism, hostname } from "node:os";
import { join } from "node:path";
import { Engine, processCpuSeconds, sampleThreads } from "./engine";
import { segmentHeader } from "./fmp4";
import { closesSegment, segmentKey } from "./hls";
import { ProjectCache } from "./materialize";
import type { Run } from "./mp4";
import {
	type AudioResultMeta,
	type AudioTask,
	MIN_PART,
	type SegmentReport,
	type TaskTimings,
	type TranscodeTask,
	type VideoResult,
	type VideoTask,
	type WorkItem,
} from "./protocol";
import { mediaS3ConfigFromEnv, S3 } from "./s3";
import {
	canRemux,
	encodedSeconds,
	probeArgs,
	remuxArgs,
	transcodeArgs,
} from "./transcode";

const s3 = new S3(mediaS3ConfigFromEnv());
const COORDINATOR = (
	process.env.RF_COORDINATOR_URL ?? "http://127.0.0.1:8080"
).replace(/\/$/, "");
const TOKEN = process.env.RF_TOKEN ?? "";
const ENGINE_BIN = process.env.RF_ENGINE_BIN ?? "cap-render-farm";
const WORK_DIR = process.env.RF_WORK_DIR ?? "/tmp/rf-worker";
const CPUS = Number(process.env.RF_CPUS ?? availableParallelism());
// Measured best on one L4 with 8 vCPUs (g6.2xlarge): 5 render slots overlap
// decode latency; 4 Studio Sound lanes use the otherwise idle cores.
const SLOTS = Number(process.env.RF_SLOTS ?? 5);
const THREADS = Math.max(1, Math.floor(CPUS / SLOTS));
// CPU-only audio lanes next to the GPU slots: with frames kept on the GPU the
// host cores sit idle, and Studio Sound sections are pure CPU work. When set,
// the GPU slots only take video.
const AUDIO_SLOTS = Number(process.env.RF_AUDIO_SLOTS ?? 4);
const SLOT_KINDS = AUDIO_SLOTS > 0 ? ["video"] : undefined;
const PREFETCH_LEAD_MS = Number(process.env.RF_PREFETCH_LEAD_MS ?? 2500);
const AUDIO_NICE = Number(process.env.RF_AUDIO_NICE ?? 10);
// A video engine that reports no frames for this long is hung (driver or
// decoder stall): kill it so the chunk fails over instead of waiting forever.
const STALL_MS = Number(process.env.RF_STALL_MS ?? 30_000);
// Recycle an engine whose device has less free VRAM than this after a task,
// so a slow leak can never grow into CUDA_ERROR_OUT_OF_MEMORY mid-export.
const MIN_FREE_VRAM_MB = Number(process.env.RF_MIN_FREE_VRAM_MB ?? 3000);
let degradedFailures: number[] = [];
const WORKER_ID = `${process.env.RF_WORKER_NAME ?? hostname()}-${randomUUID().slice(0, 6)}`;
const SERVICE = process.env.RF_SERVICE ?? "local";
const headers = {
	"content-type": "application/json",
	...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

const engines = Array.from(
	{ length: SLOTS + AUDIO_SLOTS },
	(_, slot) =>
		new Engine(
			ENGINE_BIN,
			{
				LP_NUM_THREADS: String(THREADS),
				RAYON_NUM_THREADS: String(THREADS),
				CAP_EXPORT_DISABLE_ZERO_COPY: "1",
				CAP_RENDER_LOOP_STATS: "1",
				CAP_DECODER_READAHEAD: process.env.CAP_DECODER_READAHEAD ?? "8",
			},
			`slot${slot}`,
			// Studio Sound lanes are CPU-heavy; on a 4 vCPU host they would
			// otherwise starve the render slots' decode/encode threads.
			slot >= SLOTS ? AUDIO_NICE : 0,
		),
);
// GPU slots create their device and a spare layer set at boot, not on the
// first task.
function warm(engine: Engine, slot: number) {
	if (slot < SLOTS) engine.request("warm", {}).catch(() => {});
	return engine;
}
engines.forEach(warm);
const caches = new Map<string, ProjectCache>();

function cacheFor(jobId: string) {
	let cache = caches.get(jobId);
	if (!cache) {
		const root = join(WORK_DIR, jobId);
		mkdirSync(root, { recursive: true });
		cache = new ProjectCache(s3, root);
		caches.set(jobId, cache);
	}
	return cache;
}

function dropJobs(finished: string[]) {
	for (const jobId of finished) {
		const cache = caches.get(jobId);
		if (!cache) continue;
		if (
			[...busy.values()].some(
				(task) => task.kind !== "transcode" && task.jobId === jobId,
			)
		)
			continue;
		cache.close();
		caches.delete(jobId);
		rmSync(join(WORK_DIR, jobId), { recursive: true, force: true });
	}
}

const busy = new Map<number, WorkItem>();
// Running ffmpeg transcodes, by slot, so cancels and the watchdog can stop them.
const transcoders = new Map<number, Bun.Subprocess>();
const progress = new Map<
	number,
	{
		taskId: string;
		kind: "video" | "audio" | "transcode";
		frames: number;
		total: number;
		startedAt: number;
		lastProgressAt: number;
	}
>();

async function post(path: string, body: unknown, signal?: AbortSignal) {
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(`${COORDINATOR}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
			if (!response.ok) throw new Error(`${path} -> ${response.status}`);
			return response;
		} catch (error) {
			if (attempt >= 5 || signal?.aborted) throw error;
			await Bun.sleep(250 * 2 ** attempt);
		}
	}
}

// Open /work long-polls, aborted when the worker starts draining so the
// coordinator stops handing it tasks it would never run.
const openPolls = new Set<AbortController>();

async function fetchAudio(task: VideoTask) {
	if (!task.audio) return { sizes: [] as number[], data: new Uint8Array() };
	return fetchAudioRange(task.jobId, task.audio.first, task.audio.end);
}

/** AAC packets [from, to) on the global grid; waits until they are rendered. */
async function fetchAudioRange(jobId: string, from: number, to: number) {
	if (to <= from) return { sizes: [] as number[], data: new Uint8Array() };
	const url = `${COORDINATOR}/jobs/${jobId}/audio?from=${from}&to=${to}`;
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(url, { headers });
			if (!response.ok) throw new Error(`audio -> ${response.status}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			const view = new DataView(bytes.buffer, bytes.byteOffset);
			const count = view.getUint32(0);
			const sizes = Array.from({ length: count }, (_, index) =>
				view.getUint32(4 + index * 4),
			);
			return { sizes, data: bytes.subarray(4 + count * 4) };
		} catch (error) {
			if (attempt >= 5) throw error;
			await Bun.sleep(500);
		}
	}
}

type Segment = {
	file?: { path: string; start: number; end: number };
	bytes?: Uint8Array;
};

/**
 * Publishes a chunk as HLS media segments while the engine is still encoding
 * it: every finished GOP the engine announces is on disk, so once a segment's
 * worth has accumulated it is wrapped in a moof, muxed with its audio and
 * uploaded. Players can start on chunk 0 seconds after the request.
 */
class SegmentStream {
	private sizes: number[] = [];
	private offsets = [0];
	private start = 0;
	private index = 0;
	private extradata = "";
	private uploads: Promise<void>[] = [];
	private failed: unknown = null;
	firstUploadedMs: number | null = null;

	constructor(
		private task: VideoTask & { hls: NonNullable<VideoTask["hls"]> },
		private path: string,
		private started: number,
	) {}

	onEvent(event: Record<string, unknown>) {
		if (typeof event.extradata === "string") this.extradata = event.extradata;
		const gop = event.gop as { first: number; sizes: number[] } | undefined;
		if (!gop || gop.first !== this.sizes.length) return;
		this.append(gop.sizes);
		if (
			closesSegment(this.start, this.sizes.length, this.task.hls.segmentFrames)
		) {
			this.cut(this.sizes.length, false);
		}
	}

	/** After the engine returns: publish the tail and wait for every upload. */
	async finish(allSizes: number[], extradata: string) {
		this.extradata ||= extradata;
		this.append(allSizes.slice(this.sizes.length));
		if (this.start < this.sizes.length) this.cut(this.sizes.length, true);
		await Promise.all(this.uploads);
		if (this.failed) throw this.failed;
		return this.index;
	}

	private append(sizes: number[]) {
		for (const size of sizes) {
			this.sizes.push(size);
			this.offsets.push((this.offsets[this.offsets.length - 1] ?? 0) + size);
		}
	}

	private cut(end: number, last: boolean) {
		const range: [number, number] = [this.start, end];
		this.start = end;
		const index = this.index++;
		this.uploads.push(
			this.publish(range, index, last).catch((error) => {
				this.failed ??= error;
			}),
		);
	}

	/** First AAC packet at or after output frame `frame` (the layout() rule). */
	private packetAt(frame: number) {
		const audio = this.task.audio;
		if (!audio) return 0;
		const sample = frame * (48_000 / this.task.fps);
		const packet = Math.ceil(sample / 1024) + 1;
		return Math.min(audio.end, Math.max(audio.first, packet));
	}

	private async publish(
		[a, b]: [number, number],
		index: number,
		last: boolean,
	) {
		const task = this.task;
		const first = task.frames[0];
		const video = new Uint8Array(
			await Bun.file(this.path)
				.slice(this.offsets[a] ?? 0, this.offsets[b] ?? 0)
				.arrayBuffer(),
		);
		const packets: [number, number] = task.audio
			? [
					a === 0 ? task.audio.first : this.packetAt(first + a),
					last ? task.audio.end : this.packetAt(first + b),
				]
			: [0, 0];
		const audio = await fetchAudioRange(task.jobId, packets[0], packets[1]);
		const header = segmentHeader({
			sequence: first + a + 1,
			firstFrame: first + a,
			videoSizes: this.sizes.slice(a, b),
			firstPacket: packets[0],
			audioSizes: audio.sizes,
		});
		const body = new Uint8Array(
			header.byteLength + video.byteLength + audio.data.byteLength,
		);
		body.set(header, 0);
		body.set(video, header.byteLength);
		body.set(audio.data, header.byteLength + video.byteLength);
		const key = segmentKey(
			task.hls.prefix,
			task.chunk,
			task.upload.firstPart,
			index,
		);
		await s3.put(key, body, "video/iso.segment");
		this.firstUploadedMs ??= performance.now() - this.started;
		const report: SegmentReport = {
			chunk: task.chunk,
			index,
			frames: [first + a, first + b],
			key,
			last,
			extradata: this.extradata,
		};
		await post(`/tasks/${encodeURIComponent(task.taskId)}/segment`, report);
	}
}

/**
 * Video samples interleaved with the chunk's audio packets once per second,
 * the way ffmpeg's muxer lays out a progressive MP4.
 */
function layout(
	task: VideoTask,
	videoPath: string,
	videoSizes: number[],
	audio: { sizes: number[]; data: Uint8Array },
) {
	const segments: Segment[] = [];
	const videoRuns: Run[] = [];
	const audioRuns: Run[] = [];
	const samplesPerFrame = 48_000 / task.fps;
	let offset = 0;
	let videoFile = 0;
	let frame = 0;
	let packet = 0;
	let audioByte = 0;
	const flushAudio = (untilSample: number) => {
		const firstPacket = packet;
		const startByte = audioByte;
		while (packet < audio.sizes.length) {
			const global = (task.audio?.first ?? 0) + packet;
			if ((global - 1) * 1024 >= untilSample) break;
			audioByte += audio.sizes[packet] ?? 0;
			packet++;
		}
		if (packet > firstPacket) {
			audioRuns.push({
				first: (task.audio?.first ?? 0) + firstPacket,
				count: packet - firstPacket,
				offset,
			});
			segments.push({ bytes: audio.data.subarray(startByte, audioByte) });
			offset += audioByte - startByte;
		}
	};
	const total = videoSizes.length;
	while (frame < total) {
		const blockEnd = Math.min(total, frame + task.fps);
		let blockBytes = 0;
		for (let index = frame; index < blockEnd; index++)
			blockBytes += videoSizes[index] ?? 0;
		videoRuns.push({
			first: task.frames[0] + frame,
			count: blockEnd - frame,
			offset,
		});
		segments.push({
			file: { path: videoPath, start: videoFile, end: videoFile + blockBytes },
		});
		offset += blockBytes;
		videoFile += blockBytes;
		frame = blockEnd;
		flushAudio((task.frames[0] + frame) * samplesPerFrame);
	}
	flushAudio(Number.POSITIVE_INFINITY);
	return { segments, videoRuns, audioRuns, bytes: offset };
}

async function uploadLayout(
	task: VideoTask,
	segments: Segment[],
	bytes: number,
) {
	const parts: { partNumber: number; etag: string; size: number }[] = [];
	const { upload } = task;
	let pending: Uint8Array[] = [];
	let pendingBytes = 0;
	let nextPart = upload.firstPart;
	const inflight = new Set<Promise<void>>();
	const send = async (body: Uint8Array) => {
		if (nextPart >= upload.firstPart + upload.partLimit) {
			throw new Error("chunk needs more parts than reserved");
		}
		const partNumber = nextPart++;
		const promise = s3
			.uploadPart(upload.key, upload.uploadId, partNumber, body)
			.then((etag) => {
				parts.push({ partNumber, etag, size: body.byteLength });
			});
		inflight.add(promise);
		// Handle both outcomes here: a bare .finally() re-rejects unhandled and
		// kills the whole worker (e.g. a hedge loser hitting NoSuchUpload after
		// the job completed). The failure still surfaces via race/all below.
		const forget = () => inflight.delete(promise);
		promise.then(forget, forget);
		if (inflight.size >= 4) await Promise.race(inflight);
	};
	const take = (count: number) => {
		const out = new Uint8Array(count);
		let filled = 0;
		while (filled < count) {
			const head = pending[0];
			if (!head) break;
			const use = Math.min(head.byteLength, count - filled);
			out.set(head.subarray(0, use), filled);
			filled += use;
			if (use === head.byteLength) pending.shift();
			else pending[0] = head.subarray(use);
		}
		pendingBytes -= count;
		return out;
	};
	const files = new Map<string, ReturnType<typeof Bun.file>>();
	for (const segment of segments) {
		let data: Uint8Array;
		if (segment.bytes) data = segment.bytes;
		else if (segment.file) {
			let file = files.get(segment.file.path);
			if (!file) {
				file = Bun.file(segment.file.path);
				files.set(segment.file.path, file);
			}
			data = new Uint8Array(
				await file.slice(segment.file.start, segment.file.end).arrayBuffer(),
			);
		} else continue;
		pending.push(data);
		pendingBytes += data.byteLength;
		// Always keep >= 5 MiB back so the chunk's last part is never too small.
		while (pendingBytes >= upload.partTarget + MIN_PART)
			await send(take(upload.partTarget));
	}
	let padded = 0;
	if (!upload.isLast && pendingBytes < MIN_PART) {
		// Unreferenced bytes inside mdat are legal; they keep S3's 5 MiB rule.
		padded = MIN_PART - pendingBytes;
		pending.push(new Uint8Array(padded));
		pendingBytes += padded;
	}
	if (pendingBytes > 0) await send(take(pendingBytes));
	await Promise.all(inflight);
	pending = [];
	if (parts.reduce((sum, part) => sum + part.size, 0) !== bytes + padded) {
		throw new Error("uploaded byte count mismatch");
	}
	return { parts: parts.sort((a, b) => a.partNumber - b.partNumber), padded };
}

async function runVideo(
	task: VideoTask,
	engine: Engine,
	queuedMs: number,
	nearEnd: () => void = () => {},
): Promise<VideoResult> {
	const started = performance.now();
	const cpuBefore = await processCpuSeconds(engine.pid);
	const cache = cacheFor(task.jobId);
	const fetchStats = await cache.materialize(task.files);
	const audioPromise = fetchAudio(task);
	// Awaited only after the render; without a handler until then, a failure
	// (job cancelled, coordinator unreachable) would kill the whole worker.
	audioPromise.catch(() => {});
	const out = join(
		cache.root,
		`v${task.chunk}-${randomUUID().slice(0, 6)}.h264`,
	);
	const engineStarted = performance.now();
	const slot = engines.indexOf(engine);
	const entry = {
		taskId: task.taskId,
		kind: "video" as const,
		frames: 0,
		total: task.frames[1] - task.frames[0],
		startedAt: Date.now(),
		lastProgressAt: Date.now(),
	};
	progress.set(slot, entry);
	const stream = task.hls
		? new SegmentStream({ ...task, hls: task.hls }, out, engineStarted)
		: null;
	engine.onEvent = stream ? (event) => stream.onEvent(event) : null;
	// Ask for the next task once this one is ~PREFETCH_LEAD_MS from done, so
	// its sources download while this one finishes instead of after.
	engine.onProgress = (frames) => {
		entry.frames = frames;
		entry.lastProgressAt = Date.now();
		const elapsed = performance.now() - engineStarted;
		const remainingMs =
			((entry.total - frames) * elapsed) / Math.max(1, frames);
		if (frames > 0 && remainingMs <= PREFETCH_LEAD_MS) nearEnd();
	};
	const request = engine.request<{
		width: number;
		height: number;
		sizes: number[];
		keyframes: number[];
		extradata: string;
		bytes: number;
		timings: Record<string, number>;
	}>("video", {
		project: cache.root,
		fps: task.fps,
		resolution: task.resolution,
		bpp: task.bpp,
		frames: task.frames,
		threads: task.threads,
		out,
	});
	const threadsPromise: Promise<Record<string, number>> =
		process.env.RF_PROFILE_THREADS === "1"
			? sampleThreads(engine.pid, request)
			: Promise.resolve({});
	const result = await request.finally(() => {
		engine.onProgress = null;
		engine.onEvent = null;
		progress.delete(slot);
	});
	nearEnd();
	const segmentsDone = stream?.finish(result.sizes, result.extradata);
	segmentsDone?.catch(() => {});
	const engineMs = performance.now() - engineStarted;
	const threads = await threadsPromise;
	const waitStarted = performance.now();
	const audio = await audioPromise;
	const audioWaitMs = performance.now() - waitStarted;
	const uploadStarted = performance.now();
	const plan = layout(task, out, result.sizes, audio);
	const [{ parts, padded }, segments] = await Promise.all([
		uploadLayout(task, plan.segments, plan.bytes),
		segmentsDone ?? Promise.resolve(0),
	]);
	const uploadMs = performance.now() - uploadStarted;
	rmSync(out, { force: true });
	const timings: TaskTimings = {
		queuedMs,
		fetch: fetchStats,
		engine: {
			...result.timings,
			...Object.fromEntries(
				Object.entries(threads).map(([name, value]) => [
					`thread:${name}`,
					value,
				]),
			),
			...(stream
				? { segments, firstSegmentMs: Math.round(stream.firstUploadedMs ?? -1) }
				: {}),
		},
		engineMs,
		audioWaitMs,
		uploadMs,
		totalMs: performance.now() - started,
		cpuSeconds: (await processCpuSeconds(engine.pid)) - cpuBefore,
	};
	return {
		taskId: task.taskId,
		worker: WORKER_ID,
		sizes: result.sizes,
		keyframes: result.keyframes,
		extradata: result.extradata,
		width: result.width,
		height: result.height,
		videoRuns: plan.videoRuns,
		audioRuns: plan.audioRuns,
		parts,
		bytes: plan.bytes,
		paddedBytes: padded,
		timings,
	};
}

async function runAudio(task: AudioTask, engine: Engine, queuedMs: number) {
	const started = performance.now();
	const cpuBefore = await processCpuSeconds(engine.pid);
	const cache = cacheFor(task.jobId);
	const fetchStats = await cache.materialize(task.files);
	const out = join(
		cache.root,
		`a${task.section}-${randomUUID().slice(0, 6)}.aac`,
	);
	const engineStarted = performance.now();
	// Reported in heartbeats so a restarted coordinator can re-attach it.
	const slot = engines.indexOf(engine);
	progress.set(slot, {
		taskId: task.taskId,
		kind: "audio",
		frames: 0,
		total: 0,
		startedAt: Date.now(),
		lastProgressAt: Date.now(),
	});
	// Studio Sound runs ~15x realtime; a section taking longer than a third
	// of its own length (or a minute) is a hung engine.
	const seconds = (task.range[1] - task.range[0] + task.preroll) / 48_000;
	const watchdog = setTimeout(
		() => {
			console.error(`${task.taskId}: audio section timed out, killing engine`);
			engine.kill();
		},
		Math.max(60_000, (seconds * 1000) / 3),
	);
	const result = await engine
		.request<{
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
		})
		.finally(() => {
			clearTimeout(watchdog);
			progress.delete(slot);
		});
	const engineMs = performance.now() - engineStarted;
	const data = new Uint8Array(await Bun.file(out).arrayBuffer());
	rmSync(out, { force: true });
	const meta: AudioResultMeta = {
		taskId: task.taskId,
		worker: WORKER_ID,
		firstPacket: result.first_packet,
		sizes: result.sizes,
		extradata: result.extradata,
		timings: {
			queuedMs,
			fetch: fetchStats,
			engine: result.timings,
			engineMs,
			audioWaitMs: 0,
			uploadMs: 0,
			totalMs: performance.now() - started,
			cpuSeconds: (await processCpuSeconds(engine.pid)) - cpuBefore,
		},
	};
	const json = new TextEncoder().encode(JSON.stringify(meta));
	const body = new Uint8Array(4 + json.byteLength + data.byteLength);
	new DataView(body.buffer).setUint32(0, json.byteLength);
	body.set(json, 4);
	body.set(data, 4 + json.byteLength);
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(
				`${COORDINATOR}/tasks/${encodeURIComponent(task.taskId)}/audio`,
				{
					method: "POST",
					headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
					body,
				},
			);
			if (!response.ok) throw new Error(`audio result -> ${response.status}`);
			break;
		} catch (error) {
			if (attempt >= 5) throw error;
			await Bun.sleep(500 * 2 ** attempt);
		}
	}
}

const TRANSCODE_ENCODER = process.env.RF_TRANSCODE_ENCODER ?? "h264_nvenc";

/** Re-encodes `task.source` into `task.output`; returns the stored size. */
async function runTranscode(task: TranscodeTask, slot: number) {
	const dir = join(WORK_DIR, `transcode-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	const entry = {
		taskId: task.taskId,
		kind: "transcode" as const,
		frames: 0,
		total: 0,
		startedAt: Date.now(),
		lastProgressAt: Date.now(),
	};
	progress.set(slot, entry);
	try {
		const output = join(dir, "output.mp4");
		const input = await s3.presignFresh("GET", task.source, 6 * 3600);
		const probe = Bun.spawn(["ffprobe", ...probeArgs(input)], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const probed = await new Response(probe.stdout).text();
		// H.264 with frequent keyframes (Chrome, Edge and Safari recordings)
		// only needs its container rewritten; anything else is re-encoded.
		const remux = (await probe.exited) === 0 && canRemux(probed);
		console.log(`${task.taskId}: ${remux ? "remuxing" : "transcoding"}`);
		const ffmpeg = Bun.spawn(
			[
				"ffmpeg",
				...(remux
					? remuxArgs(input, output)
					: transcodeArgs(
							input,
							output,
							task.keyframeSeconds,
							TRANSCODE_ENCODER,
						)),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		transcoders.set(slot, ffmpeg);
		const stderr = new Response(ffmpeg.stderr).text();
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const bytes of ffmpeg.stdout) {
			buffered += decoder.decode(bytes, { stream: true });
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				const seconds = encodedSeconds(line.trim());
				if (seconds !== null && seconds > entry.frames) {
					entry.frames = Math.floor(seconds);
					entry.lastProgressAt = Date.now();
				}
			}
		}
		const code = await ffmpeg.exited;
		if (code !== 0) {
			throw new Error(
				`ffmpeg exited ${code}: ${(await stderr).trim().slice(-500)}`,
			);
		}
		return await s3.uploadFile(task.output, output, "video/mp4", {
			ifNoneMatch: true,
		});
	} finally {
		transcoders.delete(slot);
		progress.delete(slot);
		rmSync(dir, { recursive: true, force: true });
	}
}

async function poll(kinds: string[] | undefined, prefetch = false) {
	const controller = new AbortController();
	openPolls.add(controller);
	const response = await post(
		"/work",
		{
			worker: WORKER_ID,
			slots: SLOTS,
			cpus: CPUS,
			service: SERVICE,
			kinds,
			audioSlots: AUDIO_SLOTS,
			prefetch,
			draining,
		},
		controller.signal,
	).finally(() => openPolls.delete(controller));
	const body = (await response.json()) as {
		task: WorkItem | null;
		finished: string[];
	};
	dropJobs(body.finished ?? []);
	return body.task;
}

// A stray rejection must not take down every slot's task with the process.
process.on("unhandledRejection", (error) => {
	console.error(`unhandled rejection: ${error}`);
});

let draining = false;
// Slots holding a prefetched (already reserved) next task, once it is known.
const reserved = new Map<number, WorkItem | null>();
const busySince = new Map<number, number>();

function exitWhenIdle() {
	if (draining && busy.size === 0 && reserved.size === 0) {
		console.log("drained; exiting");
		process.exit(0);
	}
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		if (draining) return;
		draining = true;
		for (const controller of openPolls) controller.abort();
		console.log(
			`${signal}: finishing ${busy.size} running task(s), taking no new work`,
		);
		exitWhenIdle();
	});
}

async function slotLoop(slot: number) {
	let engine = engines[slot] as Engine;
	const kinds = slot >= SLOTS ? ["audio"] : SLOT_KINDS;
	let next: Promise<WorkItem | null> | null = null;
	for (;;) {
		if (draining && !next) {
			exitWhenIdle();
			await Bun.sleep(1000);
			continue;
		}
		let task: WorkItem | null = null;
		try {
			task = next ? await next : await poll(kinds);
		} catch (error) {
			console.error(`poll failed: ${error}`);
			await Bun.sleep(1000);
			continue;
		} finally {
			next = null;
			reserved.delete(slot);
		}
		if (!task) continue;
		// Reserve the following task near the end of this one and start its
		// source download (queued work only; never a hedge).
		const prefetchNext = () => {
			if (next || draining || PREFETCH_LEAD_MS <= 0) return;
			reserved.set(slot, null);
			next = poll(kinds, true)
				.then((upcoming) => {
					if (upcoming) {
						reserved.set(slot, upcoming);
						if (upcoming.kind !== "transcode") {
							cacheFor(upcoming.jobId)
								.materialize(upcoming.files)
								.catch(() => {});
						}
					}
					return upcoming;
				})
				.catch(() => null);
		};
		const received = performance.now();
		busy.set(slot, task);
		busySince.set(slot, Date.now());
		try {
			if (!engine.alive) {
				engine = warm(
					new Engine(ENGINE_BIN, engine.env, `slot${slot}`, engine.nice),
					slot,
				);
				engines[slot] = engine;
			}
			if (task.kind === "transcode") {
				const size = await runTranscode(task, slot);
				await post(`/transcodes/${task.taskId.slice(3)}/done`, {
					worker: WORKER_ID,
					attempt: task.attempt,
					size,
				});
			} else if (task.kind === "video") {
				const result = await runVideo(task, engine, 0, prefetchNext);
				await post(`/tasks/${encodeURIComponent(task.taskId)}/done`, result);
				const vram = (
					result.timings.engine as unknown as { gpu_mem?: number[][] }
				).gpu_mem;
				const freeMb = vram?.[vram.length - 1]?.[2];
				if (freeMb !== undefined && freeMb > 0 && freeMb < MIN_FREE_VRAM_MB) {
					console.warn(
						`slot${slot}: ${freeMb} MiB VRAM free, recycling engine`,
					);
					engine.kill();
					engine = warm(
						new Engine(ENGINE_BIN, engine.env, `slot${slot}`),
						slot,
					);
					engines[slot] = engine;
				}
			} else {
				await runAudio(task, engine, 0);
			}
			console.log(
				`${task.taskId} done in ${Math.round(performance.now() - received)}ms`,
			);
		} catch (error) {
			console.error(`${task.taskId} failed: ${error}`);
			if (String(error).includes("gpu path degraded")) {
				// A fresh process usually recovers the CUDA/Vulkan state; if
				// it keeps happening, restart the whole app (boot.ts relaunches).
				engine.kill();
				const now = Date.now();
				degradedFailures = [
					...degradedFailures.filter((at) => now - at < 300_000),
					now,
				];
				if (degradedFailures.length >= 3) {
					console.error(
						"GPU path degraded 3 times in 5 min; restarting worker",
					);
					setTimeout(() => process.exit(75), 500);
				}
			}
			const failure = {
				worker: WORKER_ID,
				attempt: task.attempt,
				error: String(error instanceof Error ? error.message : error),
			};
			await post(
				task.kind === "transcode"
					? `/transcodes/${task.taskId.slice(3)}/fail`
					: `/tasks/${encodeURIComponent(task.taskId)}/fail`,
				failure,
			).catch(() => {});
		} finally {
			busy.delete(slot);
			busySince.delete(slot);
			exitWhenIdle();
		}
	}
}

/** Container CPU seconds and memory (cgroup v2), for per-job cost accounting. */
async function usage() {
	try {
		const stat = await Bun.file("/sys/fs/cgroup/cpu.stat").text();
		const usec = Number(stat.match(/usage_usec (\d+)/)?.[1] ?? 0);
		const memory = Number(
			(await Bun.file("/sys/fs/cgroup/memory.current").text()).trim(),
		);
		const throttledUsec = Number(stat.match(/throttled_usec (\d+)/)?.[1] ?? 0);
		const throttledPeriods = Number(stat.match(/nr_throttled (\d+)/)?.[1] ?? 0);
		return {
			cpuSeconds: usec / 1e6,
			memoryBytes: memory,
			throttledSeconds: throttledUsec / 1e6,
			throttledPeriods,
			cpuMax: (
				await Bun.file("/sys/fs/cgroup/cpu.max")
					.text()
					.catch(() => "")
			).trim(),
			load: (
				await Bun.file("/proc/loadavg")
					.text()
					.catch(() => "")
			).trim(),
			model: (
				await Bun.file("/proc/cpuinfo")
					.text()
					.catch(() => "")
			).match(/model name\s*:\s*(.*)/)?.[1],
			hostCpus: (
				(
					await Bun.file("/proc/cpuinfo")
						.text()
						.catch(() => "")
				).match(/^processor/gm) ?? []
			).length,
			// Host-wide jiffies: user nice system idle iowait irq softirq steal.
			hostStat: (
				await Bun.file("/proc/stat")
					.text()
					.catch(() => "")
			).split("\n")[0],
			at: Date.now(),
		};
	} catch {
		return null;
	}
}

function cancel(taskIds: string[]) {
	for (const [slot, task] of busy) {
		if (!taskIds.includes(task.taskId)) continue;
		console.log(`cancelling ${task.taskId}`);
		if (task.kind === "transcode") {
			transcoders.get(slot)?.kill("SIGKILL");
			continue;
		}
		// SIGKILL: a stopped or wedged engine never acts on SIGTERM and would
		// hold its slot until the watchdog gave up on it too.
		engines[slot]?.kill("SIGKILL");
	}
}

setInterval(() => {
	const now = Date.now();
	for (const [slot, entry] of progress) {
		if (entry.kind === "transcode") {
			// Decoding a long source can start slowly; a minute without any
			// output means a wedged ffmpeg.
			if (now - entry.lastProgressAt >= Math.max(STALL_MS, 60_000)) {
				console.error(`${entry.taskId}: no progress, killing ffmpeg`);
				entry.lastProgressAt = now;
				transcoders.get(slot)?.kill("SIGKILL");
			}
			continue;
		}
		if (entry.kind !== "video" || now - entry.lastProgressAt < STALL_MS)
			continue;
		console.error(
			`${entry.taskId}: no progress for ${now - entry.lastProgressAt} ms, killing slot${slot}`,
		);
		entry.lastProgressAt = now;
		engines[slot]?.kill("SIGKILL");
	}
}, 5_000);

setInterval(async () => {
	// Every task this worker holds, in every phase (fetch, render, upload) and
	// reserved ahead: the coordinator requeues anything a live worker stops
	// listing, and a restarted coordinator re-attaches what is listed.
	const running = [];
	for (const [slot, task] of busy) {
		const entry = progress.get(slot);
		running.push({
			taskId: task.taskId,
			attempt: task.attempt,
			phase: "running",
			frames: entry?.taskId === task.taskId ? entry.frames : 0,
			total: entry?.taskId === task.taskId ? entry.total : 0,
			elapsedMs: Date.now() - (busySince.get(slot) ?? Date.now()),
		});
	}
	for (const task of reserved.values()) {
		if (!task) continue;
		running.push({
			taskId: task.taskId,
			attempt: task.attempt,
			phase: "reserved",
			frames: 0,
			total: 0,
			elapsedMs: 0,
		});
	}
	post("/heartbeat", {
		worker: WORKER_ID,
		slots: SLOTS,
		cpus: CPUS,
		usage: await usage(),
		running,
	})
		.then(async (response) => {
			const body = (await response.json()) as {
				finished: string[];
				cancel?: string[];
			};
			cancel(body.cancel ?? []);
			dropJobs(body.finished ?? []);
		})
		.catch(() => {});
}, 3_000);

console.log(
	`render-farm worker ${WORKER_ID}: ${SLOTS} slots x ${THREADS} threads, coordinator ${COORDINATOR}`,
);
for (let slot = 0; slot < SLOTS + AUDIO_SLOTS; slot++) slotLoop(slot);

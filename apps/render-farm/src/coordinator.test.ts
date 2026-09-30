import { describe, expect, test } from "bun:test";
import {
	createHash,
	createHmac,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { ANNEX_B_PARAMETER_SETS } from "./boxes.test-util";
import type { Job, TaskState } from "./coordinator";
import * as fmp4 from "./fmp4";
import * as hls from "./hls";
import * as mp4 from "./mp4";
import * as planning from "./planning";
import * as protocol from "./protocol";
import * as recovery from "./recovery";
import { pickQueued } from "./scheduler";
import * as stitch from "./stitch";
import * as validate from "./validate";

function harness(env: Record<string, string> = {}) {
	const objects = new Map<string, Uint8Array>();
	const writes: string[] = [];
	const ranges: string[] = [];
	const uploadedParts = new Map<string, Uint8Array>();
	const modifiedAt = new Map<string, number>();
	let listFailures = 0;
	const copies: string[] = [];
	const copying = new Map<string, number>();
	const copyPeaks = { total: 0, byJob: new Map<string, number>() };
	let copyGate: (source: string) => Promise<void> | undefined = () => undefined;
	const completedParts: number[][] = [];
	const timers: (() => void)[] = [];
	const watchdogs: (() => void)[] = [];
	let putGate: Promise<void> | undefined;
	let headGate: Promise<void> | undefined;
	let failures = 0;
	const callbacks: { url: string; init: RequestInit }[] = [];
	const s3 = {
		async head(key: string) {
			await headGate;
			const value = objects.get(key);
			return value ? { size: value.byteLength } : null;
		},
		async put(key: string, body: Uint8Array | string) {
			writes.push(key);
			await putGate;
			if (failures-- > 0) throw new Error("injected storage failure");
			objects.set(
				key,
				typeof body === "string" ? new TextEncoder().encode(body) : body,
			);
		},
		async get(key: string) {
			const value = objects.get(key);
			if (!value) throw new Error(`missing ${key}`);
			return value;
		},
		async getRange(key: string, start: number, endInclusive: number) {
			ranges.push(`${key}:${start}`);
			return (await this.get(key)).subarray(start, endInclusive + 1);
		},
		async getRangeTagged(key: string, start: number, endInclusive: number) {
			const bytes = await this.getRange(key, start, endInclusive);
			const etag = `"${createHash("md5")
				.update(await this.get(key))
				.digest("hex")}"`;
			return { bytes, etag };
		},
		async list(prefix = "") {
			if (listFailures-- > 0) throw new Error("injected listing failure");
			return [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, modifiedAt: modifiedAt.get(key) ?? Date.now() }));
		},
		async presignFresh(_method: string, key: string) {
			return `https://media.test/${key}`;
		},
		config: { bucket: "farm" },
		sharesStoreWith: () => true,
		async ready() {},
		async uploadPart(key: string, _id: string, n: number, body: Uint8Array) {
			uploadedParts.set(`${key}#${n}`, body.slice());
			return `etag-${n}`;
		},
		async uploadPartCopy(
			key: string,
			_id: string,
			n: number,
			source: { key: string },
		) {
			const value = objects.get(source.key);
			if (!value) throw new Error(`missing ${source.key}`);
			const job = source.key.split("/")[1] ?? "";
			copying.set(job, (copying.get(job) ?? 0) + 1);
			const total = [...copying.values()].reduce((sum, n) => sum + n, 0);
			copyPeaks.total = Math.max(copyPeaks.total, total);
			copyPeaks.byJob.set(
				job,
				Math.max(copyPeaks.byJob.get(job) ?? 0, copying.get(job) ?? 0),
			);
			try {
				await copyGate(source.key);
			} finally {
				copying.set(job, (copying.get(job) ?? 1) - 1);
			}
			copies.push(source.key);
			uploadedParts.set(`${key}#${n}`, value);
			return `etag-${n}`;
		},
		async completeMultipart(
			key: string,
			_id: string,
			list: { partNumber: number; etag: string }[],
		) {
			const bodies = list.map((part) => {
				const body = uploadedParts.get(`${key}#${part.partNumber}`);
				if (!body)
					throw new Error(`part ${part.partNumber} was never uploaded`);
				return body;
			});
			completedParts.push(bodies.map((body) => body.byteLength));
			const out = new Uint8Array(
				bodies.reduce((sum, b) => sum + b.byteLength, 0),
			);
			let offset = 0;
			for (const body of bodies) {
				out.set(body, offset);
				offset += body.byteLength;
			}
			objects.set(key, out);
			return true;
		},
		async delete(key: string) {
			objects.delete(key);
		},
		async abortMultipart() {},
	};
	const source = readFileSync(
		new URL("./coordinator.ts", import.meta.url),
		"utf8",
	)
		.replace(/^import[\s\S]*?from "[^"]+";\n/gm, "")
		.replace(/^export type .*;\n/gm, "")
		.replace(/^resumeJobs\(\).*;$/m, "");
	let fetchHandler: (request: Request) => Promise<Response> = async () =>
		new Response();
	const deps = {
		timingSafeEqual,
		randomUUID,
		createHash,
		createHmac,
		...validate,
		...fmp4,
		...hls,
		...mp4,
		...planning,
		...protocol,
		...recovery,
		...stitch,
		pickQueuedTask: pickQueued,
		S3: class {
			constructor() {
				Object.assign(this, s3);
			}
		},
		s3ConfigFromEnv: () => ({}),
		mediaS3ConfigFromEnv: () => ({}),
		ProbeEngine: class {},
		Engine: class {},
		process: {
			env: {
				RF_TOKEN: "test",
				RF_LOCAL_AUDIO_SLOTS: "0",
				RF_HLS: "1",
				RF_CALLBACK_HOSTS: "cap.test",
				...env,
			},
		},
		Bun: {
			serve: (options: { fetch: typeof fetchHandler }) => {
				fetchHandler = options.fetch;
			},
		},
		setInterval: (callback: () => void) => {
			watchdogs.push(callback);
		},
		setTimeout: (callback: () => void) => {
			timers.push(callback);
			return { unref() {} };
		},
		clearTimeout: () => {},
		fetch: async (url: string, init: RequestInit) => {
			callbacks.push({ url, init });
			return new Response("ok");
		},
		console: { log() {}, warn() {}, error() {} },
		mkdirSync: () => {},
		rmSync: () => {},
		join: (...parts: string[]) => parts.join("/"),
	};
	const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
	const coordinator = new Function(
		...Object.keys(deps),
		`${compiled}\nreturn {jobs, queue, straggler, dispatchedTask, onVideoDone, onAudioDone, publishPlaylist, journalJob, resumeJobs, newHlsState, finish, requeue, sourceIndex, assemble, stitchAhead, sweepStashes, setPlanner: (fn) => { planJob = fn; }};`,
	)(...Object.values(deps)) as {
		setPlanner: (fn: (job: Job) => Promise<void>) => void;
		sourceIndex: (prefix: string, sourceRoot?: string) => Promise<unknown>;
		assemble: (job: Job) => Promise<void>;
		stitchAhead: (job: Job) => void;
		sweepStashes: () => Promise<void>;
		requeue: (state: TaskState, reason: string) => void;
		jobs: Map<string, Job>;
		queue: TaskState[];
		straggler: () => TaskState | undefined;
		dispatchedTask: (job: Job, state: TaskState) => Promise<protocol.Task>;
		onVideoDone: (
			job: Job,
			state: TaskState,
			result: protocol.VideoResult,
		) => Promise<void>;
		onAudioDone: (
			job: Job,
			state: TaskState,
			meta: protocol.AudioResultMeta,
			bytes: Uint8Array,
		) => Promise<void>;
		publishPlaylist: (job: Job) => Promise<void>;
		journalJob: (job: Job) => Promise<void>;
		resumeJobs: () => Promise<void>;
		newHlsState: (prefix: string) => Promise<NonNullable<Job["hls"]>>;
		finish: (job: Job) => void;
	};
	return {
		...coordinator,
		objects,
		writes,
		ranges,
		uploadedParts,
		copies,
		copying,
		copyPeaks,
		gateCopies: (gate: (source: string) => Promise<void> | undefined) => {
			copyGate = gate;
		},
		completedParts,
		modifiedAt,
		failListing: (count = 1) => {
			listFailures = count;
		},
		callbacks,
		timers,
		watchdogs,
		fetch: (request: Request) => fetchHandler(request),
		gate: (gate?: Promise<void>) => {
			putGate = gate;
		},
		gateHead: (gate?: Promise<void>) => {
			headGate = gate;
		},
		fail: (count = 1) => {
			failures = count;
		},
	};
}

function job(): Job {
	return {
		id: "job",
		request: { recording: "recording" },
		status: "rendering",
		key: "out/job.mp4",
		uploadId: "upload",
		t: { requested: Date.now() },
		fps: 30,
		bpp: 0.1,
		resolution: [1920, 1080],
		totalFrames: 60,
		totalSamples: 0,
		width: 1920,
		height: 1080,
		chunks: [0, 1].map((index) => ({
			index,
			frames: [index * 30, (index + 1) * 30],
			packets: [0, 0],
			files: [],
			firstPart: 3 + index * 60,
			partLimit: 10,
			dispatches: 0,
		})),
		sections: [],
		tasks: new Map(),
		videoResults: new Map(),
		audioSections: new Map(),
		acceptances: new Map(),
		audioWaiters: [],
		cpuSeconds: 0,
		fetchedBytes: 0,
		workersUsed: new Set(),
		waiters: [],
		taskStats: [],
	};
}

function videoState(job: Job, duplicate = false): TaskState {
	const task: protocol.VideoTask = {
		kind: "video",
		taskId: `job:v0${duplicate ? ":dup" : ""}`,
		jobId: job.id,
		chunk: 0,
		fps: 30,
		resolution: [1920, 1080],
		bpp: 0.1,
		frames: [0, 30],
		threads: 8,
		files: [],
		upload: {
			key: job.key,
			uploadId: "upload",
			firstPart: 3,
			partLimit: 10,
			partTarget: 16 << 20,
			stashKey: `stash/${job.id}/c0-p3`,
		},
		audio: null,
		hls: null,
	};
	const state: TaskState = {
		task,
		state: "running",
		attempts: 1,
		worker: duplicate ? "worker-b" : "worker-a",
		duplicateOf: duplicate ? "job:v0" : undefined,
	};
	job.tasks.set(task.taskId, state);
	return state;
}

const timings: protocol.VideoResult["timings"] = {
	queuedMs: 0,
	fetch: { bytes: 10, ms: 1, requests: 1 },
	engine: {},
	engineMs: 1,
	audioWaitMs: 0,
	uploadMs: 1,
	totalMs: 2,
	cpuSeconds: 1,
};

function result(state: TaskState): protocol.VideoResult {
	return {
		taskId: state.task.taskId,
		worker: state.worker ?? "worker",
		sizes: [100],
		keyframes: [0],
		extradata: "",
		width: 1920,
		height: 1080,
		videoRuns: [],
		audioRuns: [],
		firstPart: state.firstPart ?? 3,
		stash: {
			key: `stash/job/c0-p${state.firstPart ?? 3}`,
			bytes: 100,
		},
		parts: [],
		bytes: 100,
		timings,
	};
}

function heartbeat(worker: string, taskId: string, attempt: number) {
	return new Request("http://test/heartbeat", {
		method: "POST",
		headers: {
			authorization: "Bearer test",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			worker,
			slots: 1,
			cpus: 1,
			running: [{ taskId, attempt, frames: 1, total: 30, elapsedMs: 100 }],
		}),
	});
}

describe("assembly", () => {
	const MB = 1024 * 1024;
	/**
	 * Chunk `index` of `bytes`, filled with `fill`, stored the way a worker
	 * stores it: its stash in the farm bucket, any rest as uploaded parts.
	 */
	function stored(
		h: ReturnType<typeof harness>,
		j: Job,
		index: number,
		bytes: number,
		fill: number,
	): protocol.VideoResult {
		const chunk = j.chunks[index] as NonNullable<Job["chunks"][number]>;
		const data = new Uint8Array(bytes).fill(fill);
		const stashKey = `stash/${j.id}/c${index}-p${chunk.firstPart}`;
		const stash = stitch.stashBytes(bytes);
		h.objects.set(stashKey, data.subarray(0, stash));
		const parts: protocol.VideoResult["parts"] = [];
		if (bytes > stash) {
			h.uploadedParts.set(`${j.key}#${chunk.firstPart}`, data.subarray(stash));
			parts.push({
				partNumber: chunk.firstPart,
				etag: "worker",
				size: bytes - stash,
			});
		}
		const frames = chunk.frames[1] - chunk.frames[0];
		const sizes = Array.from({ length: frames }, (_, i) =>
			i < frames - 1
				? Math.floor(bytes / frames)
				: bytes - Math.floor(bytes / frames) * (frames - 1),
		);
		return {
			taskId: `job:v${index}`,
			worker: "worker",
			sizes,
			keyframes: [0],
			extradata: Buffer.from(ANNEX_B_PARAMETER_SETS).toString("base64"),
			width: 1920,
			height: 1080,
			videoRuns: [{ first: chunk.frames[0], count: frames, offset: 0 }],
			audioRuns: [],
			firstPart: chunk.firstPart,
			stash: { key: stashKey, bytes: stash },
			parts,
			bytes,
			timings,
		};
	}

	for (const [label, sizes] of [
		["short chunks", [220_000, 180_000]],
		["a small chunk before a large one", [220_000, 12 * MB]],
		["large chunks", [11 * MB, 13 * MB]],
	] as const) {
		test(`${label}: the file is the header then every sample, with no padding`, async () => {
			const h = harness();
			const j = job();
			const results = sizes.map((bytes, index) =>
				stored(h, j, index, bytes, index + 1),
			);
			for (const [index, result] of results.entries())
				j.videoResults.set(index, result);
			await h.assemble(j);
			const file = h.objects.get(j.key) as Uint8Array;
			const moov = mp4.locateMoov(file, file.byteLength) as {
				start: number;
				size: number;
			};
			const moovEnd = moov.start + moov.size;
			const view = new DataView(file.buffer, file.byteOffset);
			expect(
				String.fromCharCode(...file.subarray(moovEnd + 4, moovEnd + 8)),
			).toBe("mdat");
			const mdatHeader = view.getUint32(moovEnd) === 1 ? 16 : 8;
			expect(file.byteLength).toBe(moovEnd + mdatHeader + sizes[0] + sizes[1]);
			const index = mp4.indexVideoTrack(file.subarray(moov.start, moovEnd));
			for (let sample = 0; sample < index.sizes.length; sample++) {
				const offset = index.offsets[sample] ?? 0;
				const chunk = sample < 30 ? 0 : 1;
				expect(file[offset]).toBe(chunk + 1);
				expect(file[offset + (index.sizes[sample] ?? 1) - 1]).toBe(chunk + 1);
			}
			for (const size of (h.completedParts[0] ?? []).slice(0, -1)) {
				expect(size).toBeGreaterThanOrEqual(protocol.MIN_PART);
			}
		});
	}

	test("large stashes are copied server side instead of passing through the coordinator", async () => {
		const h = harness();
		const j = job();
		for (const [index, bytes] of [11 * MB, 13 * MB].entries())
			j.videoResults.set(index, stored(h, j, index, bytes, index + 1));
		await h.assemble(j);
		expect(h.copies).toEqual(["stash/job/c1-p63"]);
	});

	test("parts written while chunks render are reused, not written again", async () => {
		const h = harness();
		const j = job();
		for (const [index, bytes] of [11 * MB, 13 * MB].entries())
			j.videoResults.set(index, stored(h, j, index, bytes, index + 1));
		h.stitchAhead(j);
		await Promise.all(j.stitchParts?.values() ?? []);
		expect(h.copies).toEqual(["stash/job/c1-p63"]);
		await h.assemble(j);
		expect(h.copies).toEqual(["stash/job/c1-p63"]);
		const file = h.objects.get(j.key) as Uint8Array;
		expect(file[file.byteLength - 1]).toBe(2);
	});

	function longJob(id: string, count: number): Job {
		const base = job();
		const first = base.chunks[0] as NonNullable<Job["chunks"][number]>;
		return {
			...base,
			id,
			key: `out/${id}.mp4`,
			totalFrames: count * 30,
			chunks: Array.from({ length: count }, (_, index) => ({
				...first,
				index,
				frames: [index * 30, (index + 1) * 30] as [number, number],
				firstPart: 3 + index * 60,
			})),
		};
	}

	test("stitching ahead stays within its share across jobs and assembly reuses it", async () => {
		const h = harness();
		const jobs = [longJob("a", 12), longJob("b", 12), longJob("c", 12)];
		let open = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		h.gateCopies(() => gate);
		for (const j of jobs) {
			for (const [index] of j.chunks.entries())
				j.videoResults.set(
					index,
					stored(h, j, index, 2 * protocol.MIN_PART, 1),
				);
			h.stitchAhead(j);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(h.copyPeaks.total).toBe(8);
		for (const j of jobs)
			expect(h.copyPeaks.byJob.get(j.id) ?? 0).toBeLessThanOrEqual(4);
		open();
		for (const j of jobs) {
			await Promise.all(j.stitchParts?.values() ?? []);
			await h.assemble(j);
			const file = h.objects.get(j.key) as Uint8Array;
			expect(file.byteLength).toBeGreaterThan(12 * 2 * protocol.MIN_PART);
		}
		expect(h.copyPeaks.total).toBe(8);
		expect(h.copies.length).toBe(3 * 11);
		expect(new Set(h.copies).size).toBe(3 * 11);
	});

	test("assembly does not wait behind another job's queued ahead work", async () => {
		const h = harness();
		const busy = longJob("busy", 12);
		const ready = longJob("ready", 3);
		h.gateCopies((source) =>
			source.startsWith("stash/busy/") ? new Promise(() => {}) : undefined,
		);
		for (const [index] of busy.chunks.entries())
			busy.videoResults.set(
				index,
				stored(h, busy, index, 2 * protocol.MIN_PART, 1),
			);
		h.stitchAhead(busy);
		for (const [index] of ready.chunks.entries())
			ready.videoResults.set(
				index,
				stored(h, ready, index, 2 * protocol.MIN_PART, 2),
			);
		await h.assemble(ready);
		expect(h.objects.has(ready.key)).toBe(true);
		expect(h.copying.get("busy")).toBe(4);
	});

	test("the sweep deletes finished and abandoned jobs' stashes only", async () => {
		const h = harness();
		const live = job();
		const done = { ...job(), id: "done", status: "ready" as const };
		h.jobs.set(live.id, live);
		h.jobs.set(done.id, done);
		const old = Date.now() - 6 * 3600_000;
		for (const key of [
			"stash/job/c0-p3",
			"stash/done/c0-p3",
			"stash/abandoned/c0-p3",
			"stash/unknown/c0-p3",
		])
			h.objects.set(key, new Uint8Array(1));
		h.modifiedAt.set("stash/job/c0-p3", old);
		h.modifiedAt.set("stash/abandoned/c0-p3", old);
		await h.resumeJobs();
		expect(
			[...h.objects.keys()].filter((key) => key.startsWith("stash/")),
		).toEqual(["stash/job/c0-p3", "stash/unknown/c0-p3"]);
	});

	test("a failed journal listing retries and keeps the sweep off until it succeeds", async () => {
		const h = harness();
		const old = Date.now() - 6 * 3600_000;
		h.objects.set("stash/gone/c0-p3", new Uint8Array(1));
		h.modifiedAt.set("stash/gone/c0-p3", old);
		h.failListing(1);
		const resumed = h.resumeJobs();
		await Promise.resolve();
		await Promise.resolve();
		expect(h.timers).toHaveLength(1);
		await h.sweepStashes();
		expect(h.objects.has("stash/gone/c0-p3")).toBe(true);
		h.timers.shift()?.();
		await resumed;
		expect(h.objects.has("stash/gone/c0-p3")).toBe(false);
	});

	test("a result whose parts leave a gap in the chunk is refused", async () => {
		const h = harness();
		const j = job();
		const state = videoState(j);
		const padded = { ...stored(h, j, 0, 220_000, 1) };
		padded.parts = [{ partNumber: 3, etag: "pad", size: protocol.MIN_PART }];
		await expect(h.onVideoDone(j, state, padded)).rejects.toThrow("add up");
		expect(j.videoResults.size).toBe(0);
	});
});

describe("coordinator recovery", () => {
	test("a later dispatch waits for its reservation, resume preserves original and hedge ranges", async () => {
		const h = harness();
		const j = job();
		const original = videoState(j);
		await h.journalJob(j);
		await h.dispatchedTask(j, original);
		const hedge = videoState(j, true);
		const gate = Promise.withResolvers<void>();
		h.gate(gate.promise);
		let sent = false;
		const second = h.dispatchedTask(j, hedge).then((task) => {
			sent = true;
			return task;
		});
		await Promise.resolve();
		expect(sent).toBe(false);
		gate.resolve();
		await second;
		h.gate();
		await h.resumeJobs();
		const resumed = h.jobs.get(j.id) as Job;
		expect(resumed.chunks[0]?.dispatches).toBe(2);
		expect(resumed.tasks.get(original.task.taskId)?.duplicated).toBe(true);
		await h.fetch(heartbeat("worker-b", hedge.task.taskId, 1));
		expect(resumed.tasks.get(hedge.task.taskId)?.state).toBe("running");
		const next = await h.dispatchedTask(resumed, original);
		expect(next.kind === "video" && next.upload.firstPart).toBe(23);
	});

	test("a first dispatch writes nothing, stays retired after resume and any worker can re-attach it", async () => {
		const h = harness();
		const j = job();
		const original = videoState(j);
		await h.journalJob(j);
		const writes = h.objects.size;
		const first = await h.dispatchedTask(j, original);
		expect(first.kind === "video" ? first.upload.firstPart : -1).toBe(
			j.chunks[0]?.firstPart ?? 0,
		);
		expect(h.objects.size).toBe(writes);
		await h.resumeJobs();
		const resumed = h.jobs.get(j.id) as Job;
		expect(resumed.chunks[0]?.dispatches).toBe(1);
		await h.fetch(heartbeat("worker-c", original.task.taskId, 1));
		expect(resumed.tasks.get(original.task.taskId)?.state).toBe("running");
		expect(resumed.tasks.get(original.task.taskId)?.worker).toBe("worker-c");
	});

	test("a stale heartbeat cannot adopt a reserved newer attempt", async () => {
		const h = harness();
		const j = job();
		const original = videoState(j);
		await h.journalJob(j);
		await h.dispatchedTask(j, original);
		original.attempts = 2;
		await h.dispatchedTask(j, original);
		await h.resumeJobs();
		const resumed = h.jobs.get(j.id) as Job;
		await h.fetch(heartbeat("worker-a", original.task.taskId, 1));
		expect(resumed.tasks.get(original.task.taskId)?.state).toBe("queued");
		await h.fetch(heartbeat("worker-a", original.task.taskId, 2));
		expect(resumed.tasks.get(original.task.taskId)?.state).toBe("running");
	});

	test("concurrent winners and duplicate reports persist and count only once", async () => {
		const h = harness();
		const j = job();
		const original = videoState(j);
		const hedge = videoState(j, true);
		const gate = Promise.withResolvers<void>();
		h.gate(gate.promise);
		const first = result(original);
		const second = result(hedge);
		const accepted = h.onVideoDone(j, original, first);
		const duplicate = h.onVideoDone(j, hedge, second);
		expect(j.videoResults.size).toBe(0);
		expect(h.writes).toEqual(["jobs/job/v/0.json"]);
		gate.resolve();
		await Promise.all([accepted, duplicate]);
		await h.onVideoDone(j, original, first);
		expect(j.videoResults.get(0)?.worker).toBe("worker-a");
		expect(j.cpuSeconds).toBe(1);
		expect(original.state).toBe("done");
		expect(hedge.state).toBe("done");
		h.jobs.set(j.id, j);
		h.watchdogs[0]?.();
		h.requeue(hedge, "stale watchdog");
		expect(h.queue.length).toBe(0);
		expect(h.writes.length).toBe(1);
	});

	test("audio stays unavailable until durable, failed persistence can be retried", async () => {
		const h = harness();
		const j = job();
		const state: TaskState = {
			task: {
				kind: "audio",
				taskId: "job:a0",
				jobId: j.id,
				section: 0,
				fps: 30,
				range: [0, 1024],
				preroll: 0,
				files: [],
			},
			state: "running",
			attempts: 1,
		};
		const meta: protocol.AudioResultMeta = {
			taskId: "job:a0",
			worker: "worker",
			firstPacket: 0,
			sizes: [2],
			extradata: "",
			timings,
		};
		const bytes = new Uint8Array([1, 2]);
		h.fail();
		await expect(h.onAudioDone(j, state, meta, bytes)).rejects.toThrow(
			"injected",
		);
		expect(j.audioSections.size).toBe(0);
		expect(state.state).toBe("running");
		const gate = Promise.withResolvers<void>();
		h.gate(gate.promise);
		const pending = h.onAudioDone(j, state, meta, bytes);
		expect(j.audioSections.size).toBe(0);
		gate.resolve();
		await pending;
		expect(j.audioSections.get(0)?.data).toEqual(bytes);
	});

	test("the final playlist retries without another report or live audio data", async () => {
		const h = harness();
		const j = job();
		j.chunks.splice(1);
		j.hls = await h.newHlsState("hls/job");
		j.hls.initUrl = "https://media.test/init.mp4";
		j.hls.segments.set(
			0,
			new Map([
				[
					0,
					{
						chunk: 0,
						index: 0,
						frames: [0, 30],
						key: "segment",
						last: true,
						extradata: "",
					},
				],
			]),
		);
		h.fail();
		await h.publishPlaylist(j);
		expect(j.hls.cursor.chunk).toBe(0);
		expect(j.hls.listed).toEqual([]);
		expect(j.hls.ended).toBe(false);
		j.status = "ready";
		h.finish(j);
		expect(h.objects.has("jobs/job/done")).toBe(false);
		h.timers[0]?.();
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(j.hls.ended).toBe(true);
		expect(
			new TextDecoder().decode(h.objects.get("hls/job/index.m3u8")),
		).toContain("#EXT-X-ENDLIST");
		expect(h.objects.has("jobs/job/done")).toBe(true);
	});
});

test("a copy whose frame count stopped part-way is hedged without waiting on its average rate", () => {
	const h = harness();
	const j = job();
	h.jobs.set(j.id, j);
	for (let index = 0; index < 3; index++) {
		j.taskStats.push({ kind: "video", frames: 30, engineRenderMs: 1000 });
	}
	const original = videoState(j);
	original.progress = {
		frames: 27,
		total: 30,
		elapsedMs: 900,
		at: 0,
		advancedAt: Number.POSITIVE_INFINITY,
	};
	expect(h.straggler()).toBeUndefined();
	original.progress.advancedAt = Number.NEGATIVE_INFINITY;
	expect(h.straggler()?.duplicateOf).toBe(original.task.taskId);
	expect(original.duplicated).toBe(true);
});

test("segment reports only list objects the reporting dispatch wrote", async () => {
	const h = harness();
	const j = job();
	j.hls = await h.newHlsState("hls/job");
	const original = videoState(j);
	h.jobs.set(j.id, j);
	await h.dispatchedTask(j, original);
	const hedge = videoState(j, true);
	await h.dispatchedTask(j, hedge);
	const report = (key: string, state = original) =>
		h.fetch(
			new Request(
				`http://test/tasks/${encodeURIComponent(state.task.taskId)}/segment`,
				{
					method: "POST",
					headers: {
						authorization: "Bearer test",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						chunk: 0,
						index: 0,
						frames: [0, 30],
						key,
						last: true,
						extradata: "",
					}),
				},
			),
		);
	expect((await report("media/private.mp4")).status).toBe(400);
	expect((await report("hls/job/c0-p13-0.m4s")).status).toBe(400);
	expect((await report("hls/job/c0-p3-0.m4s", hedge)).status).toBe(400);
	expect(j.hls.segments.size).toBe(0);
	expect((await report("hls/job/c0-p13-0.m4s", hedge)).status).toBe(200);
	expect((await report("hls/job/c0-p3-0.m4s")).status).toBe(200);
	expect(j.hls.segments.get(0)?.get(0)?.key).toBe("hls/job/c0-p13-0.m4s");
});

test("job acknowledgement waits for a planning receipt and receipt-only jobs resume", async () => {
	const h = harness();
	const planned: string[] = [];
	h.setPlanner(async (job) => {
		planned.push(job.id);
	});
	const gate = Promise.withResolvers<void>();
	h.gate(gate.promise);
	let acknowledged = false;
	const response = h
		.fetch(
			new Request("http://test/jobs", {
				method: "POST",
				headers: {
					authorization: "Bearer test",
					"content-type": "application/json",
				},
				body: JSON.stringify({ recording: "recording" }),
			}),
		)
		.then((value) => {
			acknowledged = true;
			return value;
		});
	for (let i = 0; i < 20; i++) await Promise.resolve();
	expect(h.writes.length).toBe(1);
	expect(acknowledged).toBe(false);
	expect(planned).toEqual([]);
	gate.resolve();
	const receipt = (await (await response).json()) as { id: string };
	expect(h.objects.has(`jobs/${receipt.id}/request.json`)).toBe(true);
	expect(planned).toEqual([receipt.id]);
	h.jobs.clear();
	await h.resumeJobs();
	expect(planned).toEqual([receipt.id, receipt.id]);
	expect(h.jobs.get(receipt.id)?.status).toBe("planning");
});

function call(
	h: ReturnType<typeof harness>,
	path: string,
	body?: Record<string, unknown>,
) {
	return h.fetch(
		new Request(`http://test${path}`, {
			method: body ? "POST" : "GET",
			headers: {
				authorization: "Bearer test",
				"content-type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		}),
	);
}

describe("transcodes", () => {
	const request = {
		sourceRoot: "owner/video/",
		source: "owner/video/raw-upload.webm",
		output: "owner/video/.recording/render/sources/display.mp4",
	};

	test("are queued once, go to a video slot first and settle on the worker's report", async () => {
		const h = harness();
		h.objects.set(request.source, new Uint8Array(100));
		const created = (await (await call(h, "/transcodes", request)).json()) as {
			id: string;
			status: string;
		};
		expect(created.status).toBe("queued");
		const again = (await (await call(h, "/transcodes", request)).json()) as {
			id: string;
		};
		expect(again.id).toBe(created.id);
		const work = (await (
			await call(h, "/work", {
				worker: "gpu-a",
				slots: 1,
				cpus: 8,
				kinds: ["video"],
			})
		).json()) as { task: protocol.TranscodeTask };
		expect(work.task).toMatchObject({
			kind: "transcode",
			source: request.source,
			output: request.output,
			attempt: 1,
		});
		const heartbeat = (await (
			await call(h, "/heartbeat", {
				worker: "gpu-b",
				slots: 1,
				cpus: 8,
				running: [
					{
						taskId: work.task.taskId,
						attempt: 1,
						frames: 3,
						total: 0,
						elapsedMs: 10,
					},
				],
			})
		).json()) as { cancel: string[] };
		expect(heartbeat.cancel).toContain(work.task.taskId);
		h.objects.set(request.output, new Uint8Array(1234));
		await call(h, `/transcodes/${created.id}/done`, {
			worker: "gpu-a",
			attempt: 1,
			size: 1234,
		});
		expect(
			await (await call(h, `/transcodes/${created.id}`)).json(),
		).toMatchObject({ status: "ready", size: 1234 });
	});

	test("completion requires the active dispatch and matching stored bytes", async () => {
		const h = harness();
		h.objects.set(request.source, new Uint8Array(100));
		const created = (await (await call(h, "/transcodes", request)).json()) as {
			id: string;
		};
		const path = `/transcodes/${created.id}/done`;
		const report = { worker: "gpu-a", attempt: 1, size: 42 };
		expect((await call(h, path, report)).status).toBe(409);
		await call(h, "/work", { worker: "gpu-a", slots: 1, cpus: 8 });
		for (const invalid of [
			{ ...report, worker: "gpu-b" },
			{ ...report, attempt: 0 },
			{ ...report, attempt: undefined },
		]) {
			expect((await call(h, path, invalid)).status).toBe(409);
		}
		expect((await call(h, path, { ...report, size: 1.5 })).status).toBe(400);
		expect((await call(h, path, report)).status).toBe(409);
		h.objects.set(request.output, new Uint8Array(41));
		expect((await call(h, path, report)).status).toBe(409);
		expect(
			await (await call(h, `/transcodes/${created.id}`)).json(),
		).toMatchObject({
			status: "running",
		});
		h.objects.set(request.output, new Uint8Array(42));
		expect((await call(h, path, report)).status).toBe(200);
		expect((await call(h, path, report)).status).toBe(200);
		expect(
			await (await call(h, `/transcodes/${created.id}`)).json(),
		).toMatchObject({
			status: "ready",
			size: 42,
		});
	});

	test("a completion cannot settle a dispatch retired during object verification", async () => {
		const h = harness();
		h.objects.set(request.source, new Uint8Array(100));
		const created = (await (await call(h, "/transcodes", request)).json()) as {
			id: string;
		};
		await call(h, "/work", { worker: "gpu-a", slots: 1, cpus: 8 });
		h.objects.set(request.output, new Uint8Array(42));
		const gate = Promise.withResolvers<void>();
		h.gateHead(gate.promise);
		const report = { worker: "gpu-a", attempt: 1, size: 42 };
		const completing = call(h, `/transcodes/${created.id}/done`, report);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await call(h, `/transcodes/${created.id}/fail`, report);
		gate.resolve();
		expect((await completing).status).toBe(409);
		expect(
			await (await call(h, `/transcodes/${created.id}`)).json(),
		).toMatchObject({
			status: "queued",
		});
	});

	test("reuse an output already in the bucket", async () => {
		const h = harness();
		h.objects.set(request.output, new Uint8Array(42));
		expect(await (await call(h, "/transcodes", request)).json()).toMatchObject({
			status: "ready",
			size: 42,
		});
	});

	test("a fresh index can reuse a retained transcode after its raw upload is removed", async () => {
		const h = harness();
		const prefix = "owner/video/project";
		const header = mp4.buildHeader({
			width: 128,
			height: 72,
			fps: 30,
			video: {
				sizes: Uint32Array.of(1),
				runs: [{ first: 0, count: 1, offset: 0 }],
				keyframes: Uint32Array.of(0),
				avcC: mp4.avcC(ANNEX_B_PARAMETER_SETS),
			},
			audio: null,
			payloadSize: 1,
			minimumSize: 0,
		});
		const output = new Uint8Array(header.byteLength + 1);
		output.set(header);
		h.objects.set(request.output, output);
		h.objects.set(
			`${prefix}/recording-meta.json`,
			new TextEncoder().encode("{}"),
		);
		h.objects.set(
			`${prefix}/manifest.json`,
			new TextEncoder().encode(
				JSON.stringify({
					files: [
						{ path: "recording-meta.json", size: 2 },
						{
							path: "display.mp4",
							key: request.output,
							transcodeFrom: request.source,
						},
					],
				}),
			),
		);
		await expect(
			h.sourceIndex(prefix, request.sourceRoot),
		).resolves.toBeDefined();
		expect(await (await call(h, "/transcodes", request)).json()).toMatchObject({
			status: "ready",
			size: output.byteLength,
		});
	});

	test("standalone transcodes reject missing and oversized raw sources before dispatch", async () => {
		const h = harness({ RF_MAX_SOURCE_BYTES: "1000" });
		for (const size of [0, 1001]) {
			if (size > 0) h.objects.set(request.source, new Uint8Array(size));
			expect(
				await (await call(h, "/transcodes", request)).json(),
			).toMatchObject({
				status: "error",
			});
		}
		h.objects.set(request.source, new Uint8Array(1000));
		expect(await (await call(h, "/transcodes", request)).json()).toMatchObject({
			status: "queued",
		});
	});

	test("manifest quotas count every raw source before scheduling any transcode", async () => {
		const h = harness({ RF_MAX_SOURCE_BYTES: "1000" });
		const prefix = "owner/video/project";
		const files = ["display", "camera"].map((name) => ({
			path: `${name}.mp4`,
			key: `${prefix}/${name}.mp4`,
			transcodeFrom: `owner/video/${name}.webm`,
		}));
		for (const file of files) {
			h.objects.set(file.transcodeFrom, new Uint8Array(501));
		}
		for (const size of [undefined, 1]) {
			h.objects.set(
				`${prefix}/manifest.json`,
				new TextEncoder().encode(
					JSON.stringify({ files: files.map((file) => ({ ...file, size })) }),
				),
			);
			await expect(h.sourceIndex(prefix, "owner/video/")).rejects.toThrow(
				"1002 bytes (limit 1000)",
			);
			for (const file of files) {
				const id = createHash("sha256")
					.update(file.key)
					.digest("hex")
					.slice(0, 16);
				expect((await call(h, `/transcodes/${id}`)).status).toBe(404);
			}
		}
	});

	test("must stay inside their source folder", async () => {
		const h = harness();
		for (const body of [
			{ ...request, source: "other/raw-upload.webm" },
			{ ...request, output: "owner/other/display.mp4" },
			{ ...request, output: "owner/video/display.webm" },
			{ ...request, sourceRoot: "owner/../" },
		]) {
			expect((await call(h, "/transcodes", body)).status).toBe(400);
		}
	});
});

describe("jobs for the product", () => {
	test("cached indexes must satisfy each job's source scope", async () => {
		const h = harness();
		const prefix = "owner/video/project";
		h.objects.set(
			`${prefix}/manifest.json`,
			new TextEncoder().encode(
				JSON.stringify({
					files: [
						{
							path: "recording-meta.json",
							key: "owner/other/recording-meta.json",
							size: 2,
						},
					],
				}),
			),
		);
		h.objects.set(
			"owner/other/recording-meta.json",
			new TextEncoder().encode("{}"),
		);
		const cached = await h.sourceIndex(prefix, "owner/");
		expect(await h.sourceIndex(prefix, "owner/")).toBe(cached);
		await expect(h.sourceIndex(prefix, "owner/video/")).rejects.toThrow(
			"outside the recording",
		);
		await expect(h.sourceIndex(prefix)).rejects.toThrow(
			"outside the recording",
		);
	});

	test("a new project folder reuses an unchanged source's moov", async () => {
		const h = harness();
		const source = "owner/video/display.mp4";
		// Cap's recorder writes the moov after the media, past the head the
		// index reads first.
		const fileOf = (frames: number) => {
			const header = mp4.buildHeader({
				width: 128,
				height: 72,
				fps: 30,
				video: {
					sizes: new Uint32Array(frames).fill(1),
					runs: [{ first: 0, count: frames, offset: 0 }],
					keyframes: Uint32Array.of(0),
					avcC: mp4.avcC(ANNEX_B_PARAMETER_SETS),
				},
				audio: null,
				payloadSize: frames,
				minimumSize: 0,
			});
			const at = mp4.locateMoov(header, header.byteLength) as {
				start: number;
				size: number;
			};
			const mdat = 2 * 1024 * 1024;
			const bytes = new Uint8Array(mdat + at.size);
			new DataView(bytes.buffer).setUint32(0, mdat);
			bytes.set(new TextEncoder().encode("mdat"), 4);
			bytes.set(header.subarray(at.start, at.start + at.size), mdat);
			return bytes;
		};
		let folder = 0;
		const indexOf = async (bytes: Uint8Array) => {
			h.objects.set(source, bytes);
			const prefix = `owner/video/.recording/render/${folder++}/project`;
			h.objects.set(
				`${prefix}/recording-meta.json`,
				new TextEncoder().encode("{}"),
			);
			h.objects.set(
				`${prefix}/manifest.json`,
				new TextEncoder().encode(
					JSON.stringify({
						files: [
							{ path: "recording-meta.json", size: 2 },
							{ path: "display.mp4", key: source, size: bytes.byteLength },
						],
					}),
				),
			);
			const before = h.ranges.filter((range) =>
				range.startsWith(`${source}:`),
			).length;
			const index = (await h.sourceIndex(prefix, "owner/video/")) as {
				mediaMeta: Map<
					string,
					{ moov: [number, number]; index: { sizes: Uint32Array } }
				>;
			};
			const meta = index.mediaMeta.get("display.mp4");
			return {
				frames: meta?.index.sizes.length,
				moov: meta?.moov,
				reads:
					h.ranges.filter((range) => range.startsWith(`${source}:`)).length -
					before,
			};
		};

		const small = fileOf(3);
		expect(await indexOf(small)).toEqual({
			frames: 3,
			moov: [2 * 1024 * 1024, small.byteLength],
			reads: 2,
		});
		expect(await indexOf(small)).toMatchObject({ frames: 3, reads: 1 });

		const replaced = fileOf(300_000);
		expect(await indexOf(replaced)).toMatchObject({
			frames: 300_000,
			reads: 2,
		});
	});

	test("write to the requested keys and call back signed when finished", async () => {
		const h = harness();
		h.setPlanner(async () => {});
		const receipt = (await (
			await call(h, "/jobs", {
				recording: "owner/video/.recording/render/abc/project",
				sourceRoot: "owner/video/",
				output: {
					key: "owner/video/.recording/render/abc/result.mp4",
					hlsPrefix: "owner/video/.recording/render/abc/hls",
				},
				callbackUrl: "https://preview.cap.test/api/render-farm/callback",
				reference: "video-1",
			})
		).json()) as { id: string };
		const exported = h.jobs.get(receipt.id) as Job;
		expect(exported.key).toBe("owner/video/.recording/render/abc/result.mp4");
		expect(exported.hls?.prefix).toBe(
			`owner/video/.recording/render/abc/hls/${receipt.id}`,
		);
		exported.status = "ready";
		exported.totalFrames = 60;
		h.finish(exported);
		const callback = h.callbacks[0];
		expect(callback?.init.redirect).toBe("error");
		expect(callback?.url).toBe(
			"https://preview.cap.test/api/render-farm/callback",
		);
		const body = String(callback?.init.body);
		expect(JSON.parse(body)).toMatchObject({
			id: receipt.id,
			reference: "video-1",
			status: "ready",
			key: "owner/video/.recording/render/abc/result.mp4",
			durationSeconds: 2,
		});
		expect(
			(callback?.init.headers as Record<string, string>)[
				"x-render-farm-signature"
			],
		).toBe(`sha256=${createHmac("sha256", "test").update(body).digest("hex")}`);
	});

	test("refuse callbacks to hosts that are not allowed", async () => {
		const h = harness();
		h.setPlanner(async () => {});
		const response = await call(h, "/jobs", {
			recording: "recording",
			callbackUrl: "https://attacker.example/hook",
		});
		expect(response.status).toBe(400);
	});

	test("existing sources and exports cannot be selected as output keys", async () => {
		const h = harness();
		h.setPlanner(async () => {});
		const key = "owner/video/source.mp4";
		const bytes = new Uint8Array([1, 2, 3]);
		h.objects.set(key, bytes);
		expect(
			(
				await call(h, "/jobs", {
					recording: "owner/video/project",
					sourceRoot: "owner/video/",
					output: { key },
				})
			).status,
		).toBe(409);
		expect(h.jobs.size).toBe(0);
		expect(h.objects.get(key)).toBe(bytes);
	});

	test("concurrent jobs using the same HLS prefix write to separate folders", async () => {
		const h = harness();
		h.setPlanner(async () => {});
		const request = {
			recording: "recording",
			output: { key: "recording/output.mp4", hlsPrefix: "recording/hls" },
		};
		await Promise.all([call(h, "/jobs", request), call(h, "/jobs", request)]);
		expect(h.jobs.size).toBe(2);
		const prefixes = [...h.jobs.values()].map((job) => job.hls?.prefix);
		expect(new Set(prefixes).size).toBe(2);
		for (const prefix of prefixes) expect(prefix).toStartWith("recording/hls/");
	});

	test("report the share of frames rendered", async () => {
		const h = harness();
		const j = job();
		h.jobs.set(j.id, j);
		j.videoResults.set(0, {} as protocol.VideoResult);
		const running = videoState(j);
		running.task = { ...running.task, chunk: 1 } as protocol.VideoTask;
		running.progress = {
			frames: 15,
			total: 30,
			elapsedMs: 100,
			at: 0,
			advancedAt: 0,
		};
		const summary = (await (await call(h, `/jobs/${j.id}`)).json()) as {
			progress: number;
		};
		expect(summary.progress).toBe(0.75);
	});
});

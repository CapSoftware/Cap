import { describe, expect, test } from "bun:test";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Job, TaskState } from "./coordinator";
import * as fmp4 from "./fmp4";
import * as hls from "./hls";
import * as mp4 from "./mp4";
import * as planning from "./planning";
import * as protocol from "./protocol";
import * as recovery from "./recovery";
import { pickQueued } from "./scheduler";
import * as validate from "./validate";

function harness() {
	const objects = new Map<string, Uint8Array>();
	const writes: string[] = [];
	const timers: (() => void)[] = [];
	const watchdogs: (() => void)[] = [];
	let putGate: Promise<void> | undefined;
	let failures = 0;
	const s3 = {
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
		async list() {
			return [...objects.keys()].map((key) => ({ key }));
		},
		async presignFresh(_method: string, key: string) {
			return `https://media.test/${key}`;
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
		...validate,
		...fmp4,
		...hls,
		...mp4,
		...planning,
		...protocol,
		...recovery,
		pickQueuedTask: pickQueued,
		S3: class {
			constructor() {
				Object.assign(this, s3);
			}
		},
		s3ConfigFromEnv: () => ({}),
		ProbeEngine: class {},
		Engine: class {},
		process: {
			env: { RF_TOKEN: "test", RF_LOCAL_AUDIO_SLOTS: "0", RF_HLS: "1" },
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
		console: { log() {}, warn() {}, error() {} },
		mkdirSync: () => {},
		rmSync: () => {},
		join: (...parts: string[]) => parts.join("/"),
	};
	const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
	const coordinator = new Function(
		...Object.keys(deps),
		`${compiled}\nreturn {jobs, queue, dispatchedTask, onVideoDone, onAudioDone, publishPlaylist, journalJob, resumeJobs, newHlsState, finish, requeue, setPlanner: (fn) => { planJob = fn; }};`,
	)(...Object.values(deps)) as {
		setPlanner: (fn: (job: Job) => Promise<void>) => void;
		requeue: (state: TaskState, reason: string) => void;
		jobs: Map<string, Job>;
		queue: TaskState[];
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
		timers,
		watchdogs,
		fetch: (request: Request) => fetchHandler(request),
		gate: (gate?: Promise<void>) => {
			putGate = gate;
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
			firstPart: 2 + index * 60,
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
			firstPart: 2,
			partLimit: 10,
			partTarget: 16 << 20,
			isLast: false,
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
		parts: [],
		bytes: 100,
		paddedBytes: 0,
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
		expect(next.kind === "video" && next.upload.firstPart).toBe(22);
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

test("segment reports only list objects the reporting dispatch wrote", async () => {
	const h = harness();
	const j = job();
	j.hls = await h.newHlsState("hls/job");
	const original = videoState(j);
	h.jobs.set(j.id, j);
	await h.dispatchedTask(j, original);
	const report = (key: string) =>
		h.fetch(
			new Request(
				`http://test/tasks/${encodeURIComponent(original.task.taskId)}/segment`,
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
	expect((await report("hls/job/c0-p12-0.m4s")).status).toBe(400);
	expect(j.hls.segments.size).toBe(0);
	expect((await report("hls/job/c0-p2-0.m4s")).status).toBe(200);
	expect(j.hls.segments.get(0)?.get(0)?.key).toBe("hls/job/c0-p2-0.m4s");
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

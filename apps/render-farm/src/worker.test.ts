import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localServer, memoryBucket, stopLocalS3 } from "./local-s3.test-util";
import { ProjectCache } from "./materialize";
import {
	MIN_PART,
	type TranscodeTask,
	type VideoTask,
	type WorkItem,
} from "./protocol";
import { mediaS3ConfigFromEnv, S3, s3ConfigFromEnv } from "./s3";
import * as stitch from "./stitch";
import * as transcode from "./transcode";

const workDirs: string[] = [];

afterAll(() => {
	stopLocalS3();
	for (const dir of workDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const SOURCE = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
const ENCODED = new TextEncoder().encode("encoded mp4");

function harness(
	options: {
		headGate?: Promise<void>;
		probeStalls?: boolean;
		rangeGates?: Promise<void>[];
		stashFails?: boolean;
	} = {},
) {
	const spawned: string[] = [];
	const killed: string[] = [];
	const intervals: (() => void)[] = [];
	const posts: { path: string; body: unknown }[] = [];
	const signals = new Map<string, () => void>();
	const exits: number[] = [];
	const conditions: { ready: () => boolean; resolve: () => void }[] = [];
	const changed = () => {
		for (const condition of [...conditions]) {
			if (!condition.ready()) continue;
			conditions.splice(conditions.indexOf(condition), 1);
			condition.resolve();
		}
	};
	const workDir = mkdtempSync(join(tmpdir(), "rf-worker-"));
	workDirs.push(workDir);
	const media = memoryBucket("media", {
		before: async (request) => {
			changed();
			if (request.method === "HEAD") await options.headGate;
			if (request.method === "GET") await options.rangeGates?.shift();
			return undefined;
		},
	});
	media.objects.set("source.webm", {
		body: options.rangeGates
			? SOURCE.slice(0, options.rangeGates.length * 4)
			: SOURCE.slice(0, 4),
		contentType: "video/webm",
	});
	const farm = memoryBucket("farm", {
		before: () => {
			changed();
			return options.stashFails
				? new Response(
						"<Error><Code>AccessDenied</Code><Message>stash upload failed</Message></Error>",
						{ status: 403 },
					)
				: undefined;
		},
	});
	const coordinator = localServer(async (request) => {
		const body = await request.text();
		posts.push({
			path: new URL(request.url).pathname,
			body: body ? JSON.parse(body) : null,
		});
		changed();
		return Response.json({ finished: [], cancel: [] });
	});
	const env = {
		RF_SLOTS: "0",
		RF_AUDIO_SLOTS: "0",
		RF_WORK_DIR: workDir,
		RF_COORDINATOR_URL: coordinator,
		RF_S3_ENDPOINT: localServer(farm.handle),
		RF_S3_BUCKET: "farm",
		RF_S3_REGION: "us-east-1",
		RF_S3_ACCESS_KEY_ID: "a",
		RF_S3_SECRET_ACCESS_KEY: "b",
		RF_S3_URL_STYLE: "path",
		RF_MEDIA_S3_ENDPOINT: localServer(media.handle),
		RF_MEDIA_S3_BUCKET: "media",
	};
	const source = readFileSync(
		new URL("./worker.ts", import.meta.url),
		"utf8",
	).replace(/^import[\s\S]*?from "[^"]+";\n/gm, "");
	const deps = {
		randomUUID,
		join,
		...transcode,
		processCpuSeconds: async () => 0,
		sampleThreads: async () => ({}),
		downloadSource: (
			s3: transcode.RangeSource,
			key: string,
			path: string,
			options: { signal?: AbortSignal; onProgress?: (bytes: number) => void },
		) =>
			transcode.downloadSource(s3, key, path, {
				...options,
				piece: 4,
				concurrency: 1,
				onProgress: (bytes) => {
					options.onProgress?.(bytes);
					changed();
				},
			}),
		availableParallelism: () => 1,
		hostname: () => "worker-test",
		mkdirSync,
		rmSync,
		mediaS3ConfigFromEnv: () => mediaS3ConfigFromEnv(env),
		s3ConfigFromEnv: () => s3ConfigFromEnv(env),
		...stitch,
		MIN_PART,
		ProjectCache,
		S3,
		process: {
			env,
			on: (event: string, handler: () => void) => signals.set(event, handler),
			exit: (code: number) => {
				exits.push(code);
				changed();
			},
		},
		setInterval: (callback: () => void) => intervals.push(callback),
		console: { log() {}, warn() {}, error() {} },
		Bun: {
			spawn: (args: string[]) => {
				const name = args[0] ?? "";
				spawned.push(name);
				const stalls = name === "ffprobe" && options.probeStalls !== false;
				if (name === "ffmpeg") writeFileSync(args.at(-1) ?? "", ENCODED);
				const exit = Promise.withResolvers<number>();
				let output: ReadableStreamDefaultController<Uint8Array>;
				let exitCode: number | null = null;
				const stdout = new ReadableStream<Uint8Array>({
					start(controller) {
						output = controller;
						if (!stalls) {
							controller.close();
							exitCode = 0;
							exit.resolve(0);
						}
					},
				});
				changed();
				return {
					stdout,
					stderr: new Response("").body,
					exited: exit.promise,
					get exitCode() {
						return exitCode;
					},
					kill(signal: string) {
						killed.push(`${name}:${signal}`);
						if (exitCode === null) {
							exitCode = 137;
							output.close();
							exit.resolve(exitCode);
						}
					},
				};
			},
		},
	};
	const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
	const worker = new Function(
		...Object.keys(deps),
		`${compiled}\nreturn {runVideo, runTranscode, cancel, busy, progress, transcoders, engineEnv, uploadLayout, finishInBackground, finishing};`,
	)(...Object.values(deps)) as {
		runVideo: (
			task: VideoTask,
			engine: {
				pid: number;
				onEvent: ((event: Record<string, unknown>) => void) | null;
				onProgress: ((frames: number) => void) | null;
				request: (kind: string, params: { out: string }) => Promise<never>;
			},
			queuedMs: number,
		) => Promise<unknown>;
		runTranscode: (task: TranscodeTask, slot: number) => Promise<number>;
		cancel: (taskIds: string[]) => void;
		busy: Map<number, WorkItem>;
		progress: Map<number, { lastProgressAt: number }>;
		transcoders: Map<number, unknown>;
		engineEnv: (
			env: Record<string, string | undefined>,
		) => Record<string, string>;
		uploadLayout: (
			task: unknown,
			segments: { bytes: Uint8Array }[],
			bytes: number,
		) => Promise<unknown>;
		finishInBackground: (
			slot: number,
			task: unknown,
			since: number,
			done: Promise<unknown>,
		) => Promise<void>;
		finishing: Map<string, unknown>;
	};
	return {
		...worker,
		spawned,
		killed,
		intervals,
		posts,
		exits,
		media,
		farm,
		workDir,
		transcodeDirs: () =>
			readdirSync(workDir).filter((name) => name.startsWith("transcode-")),
		signal: (name: string) => signals.get(name)?.(),
		when: (ready: () => boolean) => {
			if (ready()) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			conditions.push({ ready, resolve });
			return promise;
		},
	};
}

/**
 * The rejection message of `promise`. Not `expect(promise).rejects`: it waits
 * synchronously, and once `h.when` has resumed a test from inside a local
 * server's handler, that handler could then never send its response.
 */
async function failure(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected a rejection");
}

const task: TranscodeTask = {
	kind: "transcode",
	taskId: "tc:test",
	source: "source.webm",
	output: "source.mp4",
	keyframeSeconds: 1,
};

describe("transcode cancellation", () => {
	test("cancelling a stalled probe kills it and prevents the encoder from starting", async () => {
		const h = harness();
		h.busy.set(0, task);
		const pending = h.runTranscode(task, 0);
		await h.when(() => h.spawned.length > 0);
		expect(h.spawned).toEqual(["ffprobe"]);
		const [dir] = h.transcodeDirs();
		expect([...readFileSync(join(h.workDir, dir ?? "", "source"))]).toEqual([
			1, 2, 3, 4,
		]);
		h.cancel([task.taskId]);
		expect(await failure(pending)).toContain("transcode cancelled");
		expect(h.killed).toEqual(["ffprobe:SIGKILL"]);
		expect(h.spawned).toEqual(["ffprobe"]);
		expect(h.transcoders.size).toBe(0);
		expect(h.progress.size).toBe(0);
		expect(h.transcodeDirs()).toEqual([]);
		expect(h.media.requests).toEqual(["HEAD source.webm", "GET source.webm"]);
		expect(h.media.objects.has("source.mp4")).toBe(false);
	});

	test("the watchdog releases a stalled probe without waiting for cancellation", async () => {
		const h = harness();
		const pending = h.runTranscode(task, 0);
		await h.when(() => h.spawned.length > 0);
		const progress = h.progress.get(0);
		if (!progress) throw new Error("missing progress");
		progress.lastProgressAt = 0;
		h.intervals[0]?.();
		expect(await failure(pending)).toContain("transcode cancelled");
		expect(h.killed).toEqual(["ffprobe:SIGKILL"]);
		expect(h.spawned).toEqual(["ffprobe"]);
		expect(h.transcoders.size).toBe(0);
	});

	test("a download that keeps landing ranges is not taken for a stalled transcode", async () => {
		const gates = [0, 1, 2].map(() => Promise.withResolvers<void>());
		const h = harness({ rangeGates: gates.map((gate) => gate.promise) });
		const pending = h.runTranscode(task, 0);
		const progress = h.progress.get(0);
		if (!progress) throw new Error("missing progress");
		for (const gate of gates.slice(0, 2)) {
			progress.lastProgressAt = 0;
			gate.resolve();
			await h.when(() => progress.lastProgressAt > 0);
			h.intervals[0]?.();
			expect(h.transcoders.size).toBe(1);
		}
		progress.lastProgressAt = 0;
		h.intervals[0]?.();
		gates[2]?.resolve();
		expect(await failure(pending)).toContain("transcode cancelled");
		expect(h.spawned).toEqual([]);
		expect(h.transcoders.size).toBe(0);
		expect(h.media.requests).toEqual([
			"HEAD source.webm",
			"GET source.webm",
			"GET source.webm",
			"GET source.webm",
		]);
	});

	test("cancellation while obtaining credentials prevents a later probe", async () => {
		const gate = Promise.withResolvers<void>();
		const h = harness({ headGate: gate.promise });
		h.busy.set(0, task);
		const pending = h.runTranscode(task, 0);
		await h.when(() => h.media.requests.length > 0);
		h.cancel([task.taskId]);
		gate.resolve();
		expect(await failure(pending)).toContain("transcode cancelled");
		expect(h.spawned).toEqual([]);
		expect(h.transcoders.size).toBe(0);
		expect(h.media.requests).toEqual(["HEAD source.webm"]);
	});

	test("an uncancelled source still encodes, uploads and releases its process", async () => {
		const h = harness({ probeStalls: false });
		expect(await h.runTranscode(task, 0)).toBe(ENCODED.byteLength);
		expect(h.spawned).toEqual(["ffprobe", "ffmpeg"]);
		expect(h.killed).toEqual([]);
		expect(h.media.objects.get("source.mp4")).toEqual({
			body: ENCODED,
			contentType: "video/mp4",
		});
		expect(h.transcoders.size).toBe(0);
		expect(h.progress.size).toBe(0);
		expect(h.transcodeDirs()).toEqual([]);
	});
});

describe("engine environment", () => {
	test("keeps decoder readahead off unless the deployment sets it", () => {
		const h = harness();
		expect(h.engineEnv({}).CAP_DECODER_READAHEAD).toBe("0");
		expect(
			h.engineEnv({ CAP_DECODER_READAHEAD: "4" }).CAP_DECODER_READAHEAD,
		).toBe("4");
	});
});

describe("chunk upload", () => {
	const upload = {
		key: "out/job.mp4",
		uploadId: "upload",
		firstPart: 2,
		partLimit: 3,
		partTarget: MIN_PART,
		stashKey: "stash/job/0",
	};
	const chunk = new Uint8Array(1024).map((_, index) => index % 251);

	test("a stash that failed before the final wait fails the chunk", async () => {
		const worker = harness({ stashFails: true });
		expect(
			await failure(
				worker.uploadLayout({ upload }, [{ bytes: chunk }], chunk.byteLength),
			),
		).toContain("S3 PUT stash/job/0 -> 403");
		expect(worker.farm.objects.has("stash/job/0")).toBe(false);
	});

	test("a stored stash reports the chunk's bytes", async () => {
		const worker = harness();
		expect(
			await worker.uploadLayout(
				{ upload },
				[{ bytes: chunk }],
				chunk.byteLength,
			),
		).toEqual({
			parts: [],
			stash: { key: "stash/job/0", bytes: chunk.byteLength },
		});
		expect(worker.farm.objects.get("stash/job/0")?.body).toEqual(chunk);
		expect(worker.media.requests).toEqual([]);
	});
});

test("a failed video render removes its temporary output", async () => {
	const worker = harness();
	const task: VideoTask = {
		kind: "video",
		taskId: "job:v0",
		jobId: "job",
		chunk: 0,
		fps: 30,
		resolution: [1920, 1080],
		bpp: 0.1,
		frames: [0, 30],
		threads: 1,
		files: [],
		upload: {
			key: "out/job.mp4",
			uploadId: "upload",
			firstPart: 2,
			partLimit: 3,
			partTarget: MIN_PART,
			stashKey: "stash/job/0",
		},
		audio: null,
		hls: null,
	};
	const outputs: string[] = [];
	const engine = {
		pid: 1,
		onEvent: null,
		onProgress: null,
		request: async (_kind: string, params: { out: string }) => {
			outputs.push(params.out);
			writeFileSync(params.out, "partial");
			throw new Error("render failed");
		},
	};
	expect(await failure(worker.runVideo(task, engine, 0))).toBe("render failed");
	expect(outputs).toHaveLength(1);
	expect(outputs[0]).toStartWith(join(worker.workDir, "job", "v0-"));
	expect(outputs[0]).toEndWith(".h264");
	expect(existsSync(outputs[0] ?? "")).toBe(false);
	expect(readdirSync(join(worker.workDir, "job"))).toEqual([]);
});

describe("chunks finishing after their render", () => {
	const chunk = (index: number) => ({
		kind: "video",
		taskId: `job:v${index}`,
		jobId: "job",
		chunk: index,
		attempt: 1,
		frames: [index * 100, index * 100 + 100],
	});

	test("free their slot and are reported as fully rendered", async () => {
		const h = harness();
		const audio = Promise.withResolvers<void>();
		const since = Date.now() - 5000;
		await h.finishInBackground(0, chunk(1), since, audio.promise);
		expect(h.finishing.size).toBe(1);
		for (const interval of h.intervals) await interval();
		await h.when(() => h.posts.some((post) => post.path === "/heartbeat"));
		const heartbeat = h.posts.find((post) => post.path === "/heartbeat")
			?.body as {
			running: {
				taskId: string;
				frames: number;
				total: number;
				elapsedMs: number;
			}[];
		};
		expect(heartbeat.running).toEqual([
			expect.objectContaining({ taskId: "job:v1", frames: 100, total: 100 }),
		]);
		expect(heartbeat.running[0]?.elapsedMs).toBeGreaterThanOrEqual(5000);
		h.signal("SIGTERM");
		expect(h.exits).toEqual([]);
		audio.resolve();
		await h.when(() => h.exits.length > 0);
		expect(h.exits).toEqual([0]);
		expect(h.finishing.size).toBe(0);
	});

	test("hold their slot once it has too many waiting", async () => {
		const h = harness();
		const audio = Array.from({ length: 9 }, () =>
			Promise.withResolvers<void>(),
		);
		for (let index = 0; index < 8; index++) {
			const done = audio[index] as PromiseWithResolvers<void>;
			await h.finishInBackground(0, chunk(index), Date.now(), done.promise);
		}
		let ninthReleased = false;
		const ninth = h
			.finishInBackground(
				0,
				chunk(8),
				Date.now(),
				(audio[8] as PromiseWithResolvers<void>).promise,
			)
			.then(() => {
				ninthReleased = true;
			});
		await h.finishInBackground(1, chunk(9), Date.now(), new Promise(() => {}));
		expect(ninthReleased).toBe(false);
		(audio[3] as PromiseWithResolvers<void>).resolve();
		await ninth;
		expect(ninthReleased).toBe(true);
		expect(h.finishing.has("job:v3")).toBe(false);
	});

	test("that fail are reported as failed", async () => {
		const h = harness();
		await h.finishInBackground(
			0,
			chunk(2),
			Date.now(),
			Promise.reject(new Error("audio -> 410")),
		);
		h.signal("SIGTERM");
		await h.when(() => h.exits.length > 0);
		expect(h.posts).toContainEqual({
			path: "/tasks/job%3Av2/fail",
			body: { worker: expect.any(String), attempt: 1, error: "audio -> 410" },
		});
		expect(h.finishing.size).toBe(0);
	});
});

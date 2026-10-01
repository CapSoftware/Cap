import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_PART, type TranscodeTask, type WorkItem } from "./protocol";
import * as stitch from "./stitch";
import * as transcode from "./transcode";

function harness(
	options: {
		presignGate?: Promise<void>;
		probeStalls?: boolean;
		/** Each ranged read waits for the next gate, when given. */
		rangeGates?: Promise<void>[];
		stashFails?: boolean;
	} = {},
) {
	const spawned: string[] = [];
	const killed: string[] = [];
	const removed: string[] = [];
	const intervals: (() => void)[] = [];
	const posts: { path: string; body: unknown }[] = [];
	let uploads = 0;
	const source = readFileSync(
		new URL("./worker.ts", import.meta.url),
		"utf8",
	).replace(/^import[\s\S]*?from "[^"]+";\n/gm, "");
	const deps = {
		randomUUID,
		join,
		...transcode,
		// Sources download to a real temporary file.
		downloadSource: (
			s3: transcode.RangeSource,
			key: string,
			_path: string,
			options: { signal?: AbortSignal; onProgress?: (bytes: number) => void },
		) =>
			transcode.downloadSource(
				s3,
				key,
				join(mkdtempSync(join(tmpdir(), "rf-worker-")), "source"),
				{ ...options, piece: 4, concurrency: 1 },
			),
		availableParallelism: () => 1,
		hostname: () => "worker-test",
		mkdirSync: () => {},
		rmSync: (path: string) => removed.push(path),
		mediaS3ConfigFromEnv: () => ({}),
		s3ConfigFromEnv: () => ({}),
		...stitch,
		MIN_PART,
		S3: class {
			async head() {
				await options.presignGate;
				return { size: options.rangeGates ? options.rangeGates.length * 4 : 4 };
			}
			async getRange() {
				await options.rangeGates?.shift();
				return new Uint8Array(4);
			}
			async uploadFile() {
				uploads++;
				return 42;
			}
			put() {
				return options.stashFails
					? Promise.reject(new Error("stash upload failed"))
					: Promise.resolve();
			}
			async uploadPart() {
				return "etag";
			}
		},
		process: {
			env: { RF_SLOTS: "0", RF_AUDIO_SLOTS: "0" },
			on: () => {},
		},
		setInterval: (callback: () => void) => intervals.push(callback),
		fetch: async (url: string, init?: { body?: string }) => {
			posts.push({
				path: new URL(url).pathname,
				body: init?.body ? JSON.parse(init.body) : null,
			});
			return Response.json({ finished: [], cancel: [] });
		},
		console: { log() {}, warn() {}, error() {} },
		Bun: {
			spawn: ([command]: string[]) => {
				const name = command ?? "";
				spawned.push(name);
				const exit = Promise.withResolvers<number>();
				let output: ReadableStreamDefaultController<Uint8Array>;
				let exitCode: number | null = null;
				const stdout = new ReadableStream<Uint8Array>({
					start(controller) {
						output = controller;
						if (name !== "ffprobe" || options.probeStalls === false) {
							controller.close();
							exitCode = 0;
							exit.resolve(0);
						}
					},
				});
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
		`${compiled}\nreturn {runTranscode, cancel, busy, progress, transcoders, engineEnv, uploadLayout, finishInBackground, finishing};`,
	)(...Object.values(deps)) as {
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
		removed,
		intervals,
		posts,
		uploads: () => uploads,
	};
}

const task: TranscodeTask = {
	kind: "transcode",
	taskId: "tc:test",
	source: "source.webm",
	output: "source.mp4",
	keyframeSeconds: 1,
};

/** Waits for the source download (real file I/O) to reach the probe. */
async function until(condition: () => boolean) {
	for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
}

describe("transcode cancellation", () => {
	test("cancelling a stalled probe kills it and prevents the encoder from starting", async () => {
		const h = harness();
		h.busy.set(0, task);
		const pending = h.runTranscode(task, 0);
		await until(() => h.spawned.length > 0);
		expect(h.spawned).toEqual(["ffprobe"]);
		h.cancel([task.taskId]);
		await expect(pending).rejects.toThrow("transcode cancelled");
		expect(h.killed).toEqual(["ffprobe:SIGKILL"]);
		expect(h.spawned).toEqual(["ffprobe"]);
		expect(h.transcoders.size).toBe(0);
		expect(h.progress.size).toBe(0);
		expect(h.removed).toHaveLength(1);
		expect(h.uploads()).toBe(0);
	});

	test("the watchdog releases a stalled probe without waiting for cancellation", async () => {
		const h = harness();
		const pending = h.runTranscode(task, 0);
		await until(() => h.spawned.length > 0);
		const progress = h.progress.get(0);
		if (!progress) throw new Error("missing progress");
		progress.lastProgressAt = 0;
		h.intervals[0]?.();
		await expect(pending).rejects.toThrow("transcode cancelled");
		expect(h.killed).toEqual(["ffprobe:SIGKILL"]);
		expect(h.spawned).toEqual(["ffprobe"]);
		expect(h.transcoders.size).toBe(0);
	});

	test("a download that keeps landing ranges is not taken for a stalled transcode", async () => {
		const gates = [0, 1, 2].map(() => Promise.withResolvers<void>());
		const h = harness({ rangeGates: gates.map((gate) => gate.promise) });
		const pending = h.runTranscode(task, 0);
		await until(() => h.progress.has(0));
		const progress = h.progress.get(0);
		if (!progress) throw new Error("missing progress");
		for (const gate of gates.slice(0, 2)) {
			progress.lastProgressAt = 0;
			gate.resolve();
			await until(() => progress.lastProgressAt > 0);
			h.intervals[0]?.();
			expect(h.transcoders.size).toBe(1);
		}
		// The last range never lands: the watchdog stops it.
		progress.lastProgressAt = 0;
		h.intervals[0]?.();
		gates[2]?.resolve();
		await expect(pending).rejects.toThrow("transcode cancelled");
		expect(h.spawned).toEqual([]);
		expect(h.transcoders.size).toBe(0);
	});

	test("cancellation while obtaining credentials prevents a later probe", async () => {
		const gate = Promise.withResolvers<void>();
		const h = harness({ presignGate: gate.promise });
		h.busy.set(0, task);
		const pending = h.runTranscode(task, 0);
		h.cancel([task.taskId]);
		gate.resolve();
		await expect(pending).rejects.toThrow("transcode cancelled");
		expect(h.spawned).toEqual([]);
		expect(h.transcoders.size).toBe(0);
	});

	test("an uncancelled source still encodes, uploads and releases its process", async () => {
		const h = harness({ probeStalls: false });
		expect(await h.runTranscode(task, 0)).toBe(42);
		expect(h.spawned).toEqual(["ffprobe", "ffmpeg"]);
		expect(h.killed).toEqual([]);
		expect(h.uploads()).toBe(1);
		expect(h.transcoders.size).toBe(0);
		expect(h.progress.size).toBe(0);
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
	const chunk = new Uint8Array(1024);

	test("a stash that failed before the final wait fails the chunk", async () => {
		const worker = harness({ stashFails: true });
		await expect(
			worker.uploadLayout({ upload }, [{ bytes: chunk }], chunk.byteLength),
		).rejects.toThrow("stash upload failed");
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
	});
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
	const settled = (promise: Promise<unknown>) =>
		Promise.race([promise.then(() => true), Bun.sleep(20).then(() => false)]);

	test("free their slot and are reported as fully rendered", async () => {
		const h = harness();
		const audio = Promise.withResolvers<void>();
		const since = Date.now() - 5000;
		expect(
			await settled(h.finishInBackground(0, chunk(1), since, audio.promise)),
		).toBe(true);
		// Every 3 s heartbeat lists it, frames done, with its whole task time.
		for (const interval of h.intervals) await interval();
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
		audio.resolve();
		await until(() => h.finishing.size === 0);
		expect(h.finishing.size).toBe(0);
	});

	test("hold their slot once it has too many waiting", async () => {
		const h = harness();
		const audio = Array.from({ length: 9 }, () =>
			Promise.withResolvers<void>(),
		);
		for (let index = 0; index < 8; index++) {
			const done = audio[index] as PromiseWithResolvers<void>;
			expect(
				await settled(
					h.finishInBackground(0, chunk(index), Date.now(), done.promise),
				),
			).toBe(true);
		}
		const ninth = h.finishInBackground(
			0,
			chunk(8),
			Date.now(),
			(audio[8] as PromiseWithResolvers<void>).promise,
		);
		expect(await settled(ninth)).toBe(false);
		// Another slot's chunks don't count against this one.
		expect(
			await settled(
				h.finishInBackground(1, chunk(9), Date.now(), new Promise(() => {})),
			),
		).toBe(true);
		(audio[3] as PromiseWithResolvers<void>).resolve();
		expect(await settled(ninth)).toBe(true);
	});

	test("that fail are reported as failed", async () => {
		const h = harness();
		await h.finishInBackground(
			0,
			chunk(2),
			Date.now(),
			Promise.reject(new Error("audio -> 410")),
		);
		await until(() => h.finishing.size === 0);
		expect(h.posts).toContainEqual({
			path: "/tasks/job%3Av2/fail",
			body: { worker: expect.any(String), attempt: 1, error: "audio -> 410" },
		});
		expect(h.finishing.size).toBe(0);
	});
});

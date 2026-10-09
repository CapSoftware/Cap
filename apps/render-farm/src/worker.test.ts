import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_PART, type TranscodeTask, type WorkItem } from "./protocol";
import * as stitch from "./stitch";
import * as transcode from "./transcode";

function harness(
	options: {
		presignGate?: Promise<void>;
		probeStalls?: boolean;
		stashFails?: boolean;
	} = {},
) {
	const spawned: string[] = [];
	const killed: string[] = [];
	const removed: string[] = [];
	const intervals: (() => void)[] = [];
	let uploads = 0;
	const source = readFileSync(
		new URL("./worker.ts", import.meta.url),
		"utf8",
	).replace(/^import[\s\S]*?from "[^"]+";\n/gm, "");
	const deps = {
		randomUUID,
		join,
		...transcode,
		availableParallelism: () => 1,
		hostname: () => "worker-test",
		mkdirSync: () => {},
		rmSync: (path: string) => removed.push(path),
		mediaS3ConfigFromEnv: () => ({}),
		s3ConfigFromEnv: () => ({}),
		...stitch,
		MIN_PART,
		S3: class {
			async presignFresh() {
				await options.presignGate;
				return "https://media.test/source";
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
		`${compiled}\nreturn {runTranscode, cancel, busy, progress, transcoders, engineEnv, uploadLayout};`,
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
	};
	return {
		...worker,
		spawned,
		killed,
		removed,
		intervals,
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

describe("transcode cancellation", () => {
	test("cancelling a stalled probe kills it and prevents the encoder from starting", async () => {
		const h = harness();
		h.busy.set(0, task);
		const pending = h.runTranscode(task, 0);
		for (let i = 0; i < 20; i++) await Promise.resolve();
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
		for (let i = 0; i < 20; i++) await Promise.resolve();
		const progress = h.progress.get(0);
		if (!progress) throw new Error("missing progress");
		progress.lastProgressAt = 0;
		h.intervals[0]?.();
		await expect(pending).rejects.toThrow("transcode cancelled");
		expect(h.killed).toEqual(["ffprobe:SIGKILL"]);
		expect(h.spawned).toEqual(["ffprobe"]);
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

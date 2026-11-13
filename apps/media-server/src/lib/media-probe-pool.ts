import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn as bunSpawn, type Subprocess, spawnSync } from "bun";
import { MediaAddressError } from "./media-address-guard";
import { MediaInputPolicyError } from "./media-input-policy";
import {
	computeTrackSpans,
	measureFastestFrameRate,
	type ProbedMedia,
	probeMedia,
	type TrackSpans,
	UnreadableMediaInputError,
} from "./media-probe-read";
import { withTimeout } from "./media-common";
import { childProcessEnv } from "./media-spawn";

// The parser that reads a file's structure runs in the same language runtime
// as the server, so a file that makes it allocate without bound or loop
// without yielding would take the server and every job on it down. Each read
// therefore runs in a separate process that is killed when it uses too much
// memory or time. Starting one costs far more than a probe does, so a few
// are kept running and reused.

export type ProbeWorkerOp = "metadata" | "trackSpans" | "fastestFrameRate";

export interface ProbeWorkerRequest {
	id: number;
	op: ProbeWorkerOp;
	path: string;
	internalMediaHosts: string | null;
}

export interface ProbeWorkerFailure {
	kind: "policy" | "address" | "unreadable" | "unsupported-format" | "error";
	message: string;
	cause?: string;
}

export type ProbeWorkerResponse =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; error: ProbeWorkerFailure };

interface ProbeResults {
	metadata: ProbedMedia;
	trackSpans: TrackSpans;
	fastestFrameRate: number | null;
}

const WORKER_ENTRY = join(import.meta.dir, "media-probe-worker.ts");
const MAX_PROBES_PER_WORKER = 200;
const IDLE_WORKERS_KEPT = 2;
const IDLE_RETIRE_MS = 30_000;
const START_TIMEOUT_MS = 15_000;
const DEFAULT_MEMORY_LIMIT_MB = 1024;
const MIN_MEMORY_LIMIT_MB = 128;
// Reading /proc is a few microseconds; asking ps is a process of its own.
const MEMORY_POLL_MS = process.platform === "linux" ? 25 : 100;
const PARSER_FAULT_EXIT_CODE = 70;

export function probeMemoryLimitMB(
	env: Record<string, string | undefined> = process.env,
): number {
	const configured = Number(env.MEDIA_SERVER_PROBE_MEMORY_LIMIT_MB);
	return Number.isFinite(configured) && configured >= MIN_MEMORY_LIMIT_MB
		? configured
		: DEFAULT_MEMORY_LIMIT_MB;
}

export function probeIsolationEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.MEDIA_SERVER_PROBE_ISOLATION?.trim().toLowerCase() !== "off";
}

function residentMemoryMB(pid: number): number | null {
	try {
		if (process.platform === "linux") {
			const kilobytes = readFileSync(`/proc/${pid}/status`, "utf8").match(
				/^VmRSS:\s+(\d+) kB/m,
			)?.[1];
			return kilobytes ? Number(kilobytes) / 1024 : null;
		}
		const result = spawnSync(["ps", "-o", "rss=", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
		});
		const kilobytes = Number(result.stdout.toString().trim());
		return Number.isFinite(kilobytes) && kilobytes > 0
			? kilobytes / 1024
			: null;
	} catch {
		return null;
	}
}

interface Pending {
	id: number;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

interface PoolWorker {
	proc: Subprocess;
	ready: Promise<void>;
	busy: boolean;
	served: number;
	stopped: boolean;
	pending?: Pending;
	idleTimer?: ReturnType<typeof setTimeout>;
	stopReason?: unknown;
}

const workers = new Set<PoolWorker>();
let nextRequestId = 1;
let startFailureLogged = false;
const stats = { started: 0, recycled: 0, memoryKills: 0, timeoutKills: 0 };

export function getProbeWorkerStats() {
	let idle = 0;
	for (const worker of workers) if (!worker.busy) idle++;
	return { ...stats, running: workers.size, idle };
}

// A worker that went away without this server stopping it and without the
// parser faulting: the host killed it, or it was stopped from outside.
class ProbeWorkerLostError extends Error {
	constructor() {
		super("Probe worker stopped before it answered");
	}
}

function failureToError(failure: ProbeWorkerFailure): Error {
	if (failure.kind === "policy") {
		// The class adds its own prefix to the reason it is given.
		const error = new MediaInputPolicyError("");
		error.message = failure.message;
		return error;
	}
	if (failure.kind === "address") return new MediaAddressError(failure.message);
	if (failure.kind === "unreadable") {
		return new UnreadableMediaInputError(
			failure.message,
			failure.cause === undefined ? undefined : { cause: failure.cause },
		);
	}
	const error = new Error(failure.message);
	if (failure.kind === "unsupported-format") {
		error.name = "UnsupportedInputFormatError";
	}
	return error;
}

function stopWorker(worker: PoolWorker, reason?: unknown): void {
	if (worker.stopped) return;
	worker.stopped = true;
	worker.stopReason = reason;
	workers.delete(worker);
	clearTimeout(worker.idleTimer);
	try {
		worker.proc.kill("SIGKILL");
	} catch {}
}

function startWorker(): PoolWorker {
	let markReady: () => void = () => {};
	let failStart: (error: unknown) => void = () => {};
	const ready = new Promise<void>((resolve, reject) => {
		markReady = resolve;
		failStart = reject;
	});
	// Rejected when a worker dies before it is ever used.
	ready.catch(() => {});
	const worker: PoolWorker = {
		proc: undefined as unknown as Subprocess,
		ready,
		busy: false,
		served: 0,
		stopped: false,
	};
	worker.proc = bunSpawn({
		cmd: [process.execPath, WORKER_ENTRY],
		env: childProcessEnv(process.env),
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		serialization: "json",
		ipc(message: ProbeWorkerResponse) {
			if (message.id === 0) {
				markReady();
				return;
			}
			const pending = worker.pending;
			if (!pending || pending.id !== message.id) return;
			worker.pending = undefined;
			if (message.ok) pending.resolve(message.value);
			else pending.reject(failureToError(message.error));
		},
	});
	worker.proc.unref();
	stats.started++;
	workers.add(worker);
	const startTimer = setTimeout(() => {
		failStart(new Error("Probe worker did not start"));
		stopWorker(worker);
	}, START_TIMEOUT_MS);
	void ready.then(
		() => clearTimeout(startTimer),
		() => clearTimeout(startTimer),
	);
	void worker.proc.exited.then((exitCode) => {
		const deliberate = worker.stopped;
		worker.stopped = true;
		workers.delete(worker);
		clearTimeout(worker.idleTimer);
		failStart(new Error("Probe worker exited before it was ready"));
		const pending = worker.pending;
		worker.pending = undefined;
		if (!pending) return;
		if (deliberate && worker.stopReason !== undefined) {
			pending.reject(worker.stopReason);
		} else if (exitCode === PARSER_FAULT_EXIT_CODE) {
			pending.reject(
				new UnreadableMediaInputError("Media input could not be read", {
					cause: "the parser stopped on this file",
				}),
			);
		} else {
			pending.reject(new ProbeWorkerLostError());
		}
	});
	return worker;
}

function idleWorkerCount(): number {
	let idle = 0;
	for (const worker of workers) if (!worker.busy) idle++;
	return idle;
}

function release(worker: PoolWorker, healthy: boolean): void {
	worker.busy = false;
	if (!healthy || worker.served >= MAX_PROBES_PER_WORKER) {
		stats.recycled++;
		stopWorker(worker);
		if (idleWorkerCount() === 0) startWorker();
		return;
	}
	if (idleWorkerCount() > IDLE_WORKERS_KEPT) {
		worker.idleTimer = setTimeout(() => {
			if (!worker.busy) stopWorker(worker);
		}, IDLE_RETIRE_MS);
		worker.idleTimer.unref?.();
	}
}

function acquire(): PoolWorker {
	for (const worker of workers) {
		if (worker.busy || worker.stopped) continue;
		clearTimeout(worker.idleTimer);
		worker.busy = true;
		return worker;
	}
	const worker = startWorker();
	worker.busy = true;
	return worker;
}

// Starts the first worker ahead of the first probe.
export function warmProbeWorkers(): void {
	if (!probeIsolationEnabled() || workers.size > 0) return;
	try {
		startWorker();
	} catch (error) {
		console.error("[probe] Could not start a probe worker:", error);
	}
}

export function stopProbeWorkers(): void {
	for (const worker of [...workers]) stopWorker(worker);
}

process.on("exit", stopProbeWorkers);

function inProcess<Op extends ProbeWorkerOp>(
	op: Op,
	path: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ProbeResults[Op]> {
	const stopped = new AbortController();
	const combined = signal
		? AbortSignal.any([signal, stopped.signal])
		: stopped.signal;
	const run =
		op === "metadata"
			? probeMedia(path)
			: op === "trackSpans"
				? computeTrackSpans(path)
				: measureFastestFrameRate(path, combined);
	return withTimeout(run as Promise<ProbeResults[Op]>, timeoutMs, () =>
		stopped.abort(),
	);
}

class ProbeWorkerStartError extends Error {}

async function inWorker<Op extends ProbeWorkerOp>(
	op: Op,
	path: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ProbeResults[Op]> {
	signal?.throwIfAborted();
	let worker: PoolWorker;
	try {
		worker = acquire();
	} catch (error) {
		throw new ProbeWorkerStartError(String(error));
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let memoryWatch: ReturnType<typeof setInterval> | undefined;
	let onAbort: (() => void) | undefined;
	let healthy = false;
	try {
		const answer = new Promise<unknown>((resolve, reject) => {
			const stop = (reason: unknown) => {
				// The exit handler rejects a request that was sent; one that
				// was not is rejected here.
				stopWorker(worker, reason);
				reject(reason);
			};
			timer = setTimeout(() => {
				stats.timeoutKills++;
				stop(new Error(`Operation timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			onAbort = () =>
				stop(signal?.reason ?? new DOMException("Aborted", "AbortError"));
			signal?.addEventListener("abort", onAbort, { once: true });
			const limitMB = probeMemoryLimitMB();
			memoryWatch = setInterval(() => {
				const usedMB = residentMemoryMB(worker.proc.pid);
				if (usedMB === null || usedMB <= limitMB) return;
				stats.memoryKills++;
				console.warn(
					`[probe] Worker stopped at ${Math.round(usedMB)} MB, over its ${limitMB} MB limit`,
				);
				stop(
					new UnreadableMediaInputError("Media input could not be read", {
						cause: "reading it needs more memory than a probe may use",
					}),
				);
			}, MEMORY_POLL_MS);
			worker.ready.then(
				() => {
					if (worker.stopped) return;
					const id = nextRequestId++;
					worker.pending = { id, resolve, reject };
					worker.proc.send({
						id,
						op,
						path,
						internalMediaHosts:
							process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS ?? null,
					} satisfies ProbeWorkerRequest);
				},
				(error) => {
					if (worker.stopReason === undefined) {
						reject(new ProbeWorkerStartError(String(error)));
					}
				},
			);
		});
		const value = (await answer) as ProbeResults[Op];
		healthy = true;
		return value;
	} finally {
		clearTimeout(timer);
		clearInterval(memoryWatch);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		worker.served++;
		release(worker, healthy);
	}
}

export async function runProbe<Op extends ProbeWorkerOp>(
	op: Op,
	path: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ProbeResults[Op]> {
	if (!probeIsolationEnabled()) {
		return await inProcess(op, path, timeoutMs, signal);
	}
	try {
		try {
			return await inWorker(op, path, timeoutMs, signal);
		} catch (error) {
			// Asked once more on a fresh worker: the first may have been
			// lost to something other than this file.
			if (!(error instanceof ProbeWorkerLostError)) throw error;
			return await inWorker(op, path, timeoutMs, signal);
		}
	} catch (error) {
		if (!(error instanceof ProbeWorkerStartError)) throw error;
		// A server that cannot start a worker still has to answer.
		if (!startFailureLogged) {
			startFailureLogged = true;
			console.error(
				"[probe] Probe workers cannot start, reading in the server process:",
				error.message,
			);
		}
		return await inProcess(op, path, timeoutMs, signal);
	}
}

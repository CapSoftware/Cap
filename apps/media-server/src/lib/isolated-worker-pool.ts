import { readFileSync } from "node:fs";
import { spawn as bunSpawn, type Subprocess, spawnSync } from "bun";

// Runs requests in child processes that are stopped when one uses too much
// memory or time, so a fault in what they run cannot reach the server.
// Starting a process costs far more than a small request does, so a few are
// kept running and reused, one request at a time each.

export type WorkerResponse<Failure> =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; error: Failure };

// The worker stopped without this pool stopping it and without reporting a
// fault of its own: the host killed it, or it was stopped from outside.
export class WorkerLostError extends Error {
	constructor() {
		super("Worker stopped before it answered");
	}
}

export class WorkerStartError extends Error {}

export interface WorkerPoolOptions<Failure> {
	entry: string;
	env: () => Record<string, string>;
	memoryLimitMB: () => number;
	toError: (failure: Failure) => unknown;
	// What a request is answered with when its worker is stopped for using
	// too much memory, or exits with faultExitCode.
	memoryError: () => unknown;
	faultError: () => unknown;
	faultExitCode: number;
	maxRequestsPerWorker?: number;
	// Workers running at once. A request that finds every one busy waits for
	// one to come free.
	maxWorkers?: () => number;
	idleWorkersKept?: number;
	idleRetireMs?: number;
	startTimeoutMs?: number;
	label?: string;
}

// Reading /proc is a few microseconds; asking ps is a process of its own.
const MEMORY_POLL_MS = process.platform === "linux" ? 25 : 100;

export function residentMemoryMB(pid: number): number | null {
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
	// The id of the last request this worker answered, with a value or with
	// a failure it reported itself.
	answered: number;
	pending?: Pending;
	idleTimer?: ReturnType<typeof setTimeout>;
	stopReason?: unknown;
}

export interface WorkerPool<Request> {
	run(
		request: Request,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<unknown>;
	warm(): void;
	stop(): void;
	stats(): {
		started: number;
		recycled: number;
		memoryKills: number;
		timeoutKills: number;
		running: number;
		idle: number;
		waiting: number;
	};
}

export function createWorkerPool<Request extends object, Failure>(
	options: WorkerPoolOptions<Failure>,
): WorkerPool<Request> {
	const maxRequestsPerWorker = options.maxRequestsPerWorker ?? 200;
	const idleWorkersKept = options.idleWorkersKept ?? 2;
	const idleRetireMs = options.idleRetireMs ?? 30_000;
	const startTimeoutMs = options.startTimeoutMs ?? 15_000;
	const label = options.label ?? "worker";
	const maxWorkers = () => Math.max(1, options.maxWorkers?.() ?? 4);
	const workers = new Set<PoolWorker>();
	const waiting: (() => void)[] = [];
	const counters = {
		started: 0,
		recycled: 0,
		memoryKills: 0,
		timeoutKills: 0,
	};
	let nextRequestId = 1;

	const idleCount = () => {
		let idle = 0;
		for (const worker of workers) if (!worker.busy) idle++;
		return idle;
	};

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
			answered: 0,
		};
		worker.proc = bunSpawn({
			cmd: [process.execPath, options.entry],
			env: options.env(),
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
			serialization: "json",
			ipc(message: WorkerResponse<Failure>) {
				if (message.id === 0) {
					markReady();
					return;
				}
				const pending = worker.pending;
				if (!pending || pending.id !== message.id) return;
				worker.pending = undefined;
				worker.answered = message.id;
				if (message.ok) pending.resolve(message.value);
				else pending.reject(options.toError(message.error));
			},
		});
		worker.proc.unref();
		counters.started++;
		workers.add(worker);
		const startTimer = setTimeout(() => {
			failStart(new WorkerStartError(`The ${label} did not start`));
			stopWorker(worker);
		}, startTimeoutMs);
		const started = () => clearTimeout(startTimer);
		void ready.then(started, started);
		void worker.proc.exited.then((exitCode) => {
			const deliberate = worker.stopped;
			worker.stopped = true;
			workers.delete(worker);
			clearTimeout(worker.idleTimer);
			failStart(
				new WorkerStartError(`The ${label} exited before it was ready`),
			);
			const pending = worker.pending;
			worker.pending = undefined;
			if (!pending) return;
			if (deliberate && worker.stopReason !== undefined) {
				pending.reject(worker.stopReason);
			} else if (exitCode === options.faultExitCode) {
				pending.reject(options.faultError());
			} else {
				pending.reject(new WorkerLostError());
			}
		});
		return worker;
	}

	function wakeWaiter(): void {
		waiting.shift()?.();
	}

	function release(worker: PoolWorker, healthy: boolean): void {
		worker.busy = false;
		if (!healthy || worker.served >= maxRequestsPerWorker) {
			counters.recycled++;
			stopWorker(worker);
			if (idleCount() === 0 && workers.size < maxWorkers()) {
				try {
					startWorker();
				} catch {}
			}
			wakeWaiter();
			return;
		}
		wakeWaiter();
		if (idleCount() > idleWorkersKept) {
			worker.idleTimer = setTimeout(() => {
				if (!worker.busy) stopWorker(worker);
			}, idleRetireMs);
			worker.idleTimer.unref?.();
		}
	}

	function tryAcquire(): PoolWorker | null {
		for (const worker of workers) {
			if (worker.busy || worker.stopped) continue;
			clearTimeout(worker.idleTimer);
			worker.busy = true;
			return worker;
		}
		if (workers.size >= maxWorkers()) return null;
		const worker = startWorker();
		worker.busy = true;
		return worker;
	}

	async function acquire(
		deadline: number,
		signal?: AbortSignal,
	): Promise<PoolWorker> {
		while (true) {
			const worker = tryAcquire();
			if (worker) return worker;
			await new Promise<void>((resolve, reject) => {
				const wake = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolve();
				};
				const leave = (reason: unknown) => {
					const index = waiting.indexOf(wake);
					if (index !== -1) waiting.splice(index, 1);
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					reject(reason);
				};
				const onAbort = () =>
					leave(signal?.reason ?? new DOMException("Aborted", "AbortError"));
				const timer = setTimeout(
					() =>
						leave(
							new Error(
								`Operation timed out after waiting for a free ${label}`,
							),
						),
					Math.max(0, deadline - performance.now()),
				);
				waiting.push(wake);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
	}

	async function run(
		request: Request,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		signal?.throwIfAborted();
		const deadline = performance.now() + timeoutMs;
		let worker: PoolWorker;
		try {
			worker = await acquire(deadline, signal);
		} catch (error) {
			if (error instanceof Error && error.message.includes("timed out"))
				throw error;
			if (signal?.aborted) throw error;
			throw new WorkerStartError(String(error));
		}
		// Cancelled while it waited for a worker: the worker goes back unused.
		if (signal?.aborted) {
			release(worker, true);
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		const requestId = nextRequestId++;
		const remainingMs = Math.max(1, deadline - performance.now());
		let timer: ReturnType<typeof setTimeout> | undefined;
		let memoryWatch: ReturnType<typeof setInterval> | undefined;
		let onAbort: (() => void) | undefined;
		let healthy = false;
		try {
			const value = await new Promise<unknown>((resolve, reject) => {
				const stop = (reason: unknown) => {
					stopWorker(worker, reason);
					reject(reason);
				};
				timer = setTimeout(() => {
					counters.timeoutKills++;
					stop(new Error(`Operation timed out after ${timeoutMs}ms`));
				}, remainingMs);
				onAbort = () =>
					stop(signal?.reason ?? new DOMException("Aborted", "AbortError"));
				signal?.addEventListener("abort", onAbort, { once: true });
				const limitMB = options.memoryLimitMB();
				memoryWatch = setInterval(() => {
					const usedMB = residentMemoryMB(worker.proc.pid);
					if (usedMB === null || usedMB <= limitMB) return;
					counters.memoryKills++;
					console.warn(
						`[${label}] Stopped at ${Math.round(usedMB)} MB, over its ${limitMB} MB limit`,
					);
					stop(options.memoryError());
				}, MEMORY_POLL_MS);
				worker.ready.then(
					() => {
						if (worker.stopped) return;
						worker.pending = { id: requestId, resolve, reject };
						worker.proc.send({ ...request, id: requestId });
					},
					(error) => {
						if (worker.stopReason === undefined) reject(error);
					},
				);
			});
			return value;
		} finally {
			// A worker that answered, even with a failure it reported, is
			// reused. One that was stopped, crashed or never answered is not.
			healthy = !worker.stopped && worker.answered === requestId;
			clearTimeout(timer);
			clearInterval(memoryWatch);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			worker.served++;
			release(worker, healthy);
		}
	}

	const stop = () => {
		for (const worker of [...workers]) stopWorker(worker);
	};
	process.on("exit", stop);

	return {
		run,
		stop,
		warm() {
			if (workers.size > 0) return;
			try {
				startWorker();
			} catch (error) {
				console.error(`[${label}] Could not start:`, error);
			}
		},
		stats: () => ({
			...counters,
			running: workers.size,
			idle: idleCount(),
			waiting: waiting.length,
		}),
	};
}

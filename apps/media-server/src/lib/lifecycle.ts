import { getActiveVideoProcessCount } from "./job-manager";
import {
	getActiveAudioOperationCount,
	getActiveProbeOperationCount,
} from "./media-operations";
import { getActiveSubprocessCount } from "./subprocess";

const DRAIN_POLL_INTERVAL_MS = 250;
const DRAIN_LOG_INTERVAL_MS = 30_000;
export const DRAIN_RETRY_AFTER_SECONDS = 15;
export const DRAINING_DETAILS =
	"Server is draining for shutdown, please retry later";

const MAX_IDLE_TIMEOUT_SECONDS = 255;

let draining = false;
let inFlightRequests = 0;
const backgroundTasks = new Set<Promise<unknown>>();

// Bun closes a connection after idleTimeout seconds without I/O, including
// while a handler is still working, and its 10 s default is shorter than the
// AWS ALB keep-alive idle timeout (60 s), which turns reused sockets into 502s.
export function getIdleTimeoutSeconds(): number {
	const value = Number.parseInt(
		process.env.MEDIA_SERVER_IDLE_TIMEOUT_SECONDS ?? "",
		10,
	);
	return Number.isFinite(value) && value >= 0
		? Math.min(MAX_IDLE_TIMEOUT_SECONDS, value)
		: MAX_IDLE_TIMEOUT_SECONDS;
}

// A streamed response can stay silent while ffmpeg opens its input, so the
// idle timeout only comes back once the first bytes are on their way.
export function restoreIdleTimeoutOnFirstChunk(
	stream: ReadableStream<Uint8Array>,
	restore: () => void,
): ReadableStream<Uint8Array> {
	let restored = false;
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (!restored) {
					restored = true;
					restore();
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

type IdleTimeoutServer = {
	timeout?: (request: Request, seconds: number) => void;
};

export function setRequestIdleTimeout(
	server: unknown,
	request: Request,
	seconds: number,
): void {
	const timeout = (server as IdleTimeoutServer | undefined)?.timeout;
	if (typeof timeout !== "function") return;
	try {
		timeout.call(server, request, seconds);
	} catch {}
}

export function getShutdownGraceMs(): number {
	const value = Number.parseInt(
		process.env.MEDIA_SERVER_SHUTDOWN_GRACE_MS ?? "0",
		10,
	);
	return Number.isFinite(value) && value > 0 ? value : 0;
}

export function isDraining(): boolean {
	return draining;
}

export function setDraining(value: boolean): void {
	draining = value;
}

export function trackBackgroundTask<T>(task: Promise<T>): Promise<T> {
	backgroundTasks.add(task);
	const settle = () => {
		backgroundTasks.delete(task);
	};
	task.then(settle, settle);
	return task;
}

export function beginRequest(): () => void {
	inFlightRequests++;
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		inFlightRequests--;
	};
}

export function getDrainBlockers() {
	return {
		activeVideoProcesses: getActiveVideoProcessCount(),
		backgroundTasks: backgroundTasks.size,
		inFlightRequests,
		audioOperations: getActiveAudioOperationCount(),
		probeOperations: getActiveProbeOperationCount(),
		subprocesses: getActiveSubprocessCount(),
	};
}

export function isIdle(): boolean {
	return Object.values(getDrainBlockers()).every((count) => count === 0);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

export async function waitForDrain(
	graceMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	const startedAt = Date.now();
	const deadline = startedAt + graceMs;
	let lastLogAt = startedAt;
	while (!isIdle()) {
		const now = Date.now();
		if (signal?.aborted || now >= deadline) return false;
		if (now - lastLogAt >= DRAIN_LOG_INTERVAL_MS) {
			lastLogAt = now;
			console.log("[media-server] Draining", {
				remainingMs: deadline - now,
				...getDrainBlockers(),
			});
		}
		await wait(Math.min(DRAIN_POLL_INTERVAL_MS, deadline - now), signal);
	}
	return true;
}

export function createShutdownHandler(
	finalize: () => Promise<void>,
	graceMs = getShutdownGraceMs,
): (signal: string) => Promise<void> {
	let shuttingDown = false;
	let forceDrain: AbortController | undefined;

	return async (signal) => {
		if (forceDrain) {
			console.log(
				`[media-server] Received ${signal} while draining, shutting down now`,
			);
			forceDrain.abort();
			return;
		}
		if (shuttingDown) return;
		shuttingDown = true;

		const drainMs = graceMs();
		if (drainMs > 0) {
			forceDrain = new AbortController();
			setDraining(true);
			console.log(
				`[media-server] Received ${signal}, draining for up to ${drainMs}ms`,
				getDrainBlockers(),
			);
			const drained = await waitForDrain(drainMs, forceDrain.signal);
			console.log(
				drained
					? "[media-server] Drain complete"
					: "[media-server] Drain ended with work still active",
				getDrainBlockers(),
			);
		} else {
			console.log("[media-server] Shutting down...");
		}

		await finalize();
	};
}

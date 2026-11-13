import { join } from "node:path";
import {
	createWorkerPool,
	WorkerLostError,
	WorkerStartError,
} from "./isolated-worker-pool";
import { MediaAddressError } from "./media-address-guard";
import { withTimeout } from "./media-common";
import { MediaInputPolicyError } from "./media-input-policy";
import { getMaxConcurrentProbeOperations } from "./media-operations";
import {
	computeTrackSpans,
	MediaInputNotAccessibleError,
	measureFastestFrameRate,
	PARSER_FAULT_EXIT_CODE,
	type ProbedMedia,
	probeMedia,
	type TrackSpans,
	UnreadableMediaInputError,
} from "./media-probe-read";
import { childProcessEnv } from "./media-spawn";

// The parser that reads a file's structure runs in the same language runtime
// as the server, so a file that makes it allocate without bound or loop
// without yielding would take the server and every job on it down. Each read
// therefore runs in a probe worker, a separate process that is stopped when
// it uses too much memory or time.

export type ProbeWorkerOp = "metadata" | "trackSpans" | "fastestFrameRate";

export interface ProbeWorkerRequest {
	id: number;
	op: ProbeWorkerOp;
	path: string;
	internalMediaHosts: string | null;
}

export interface ProbeWorkerFailure {
	kind:
		| "policy"
		| "address"
		| "unreadable"
		| "not-accessible"
		| "unsupported-format"
		| "error";
	message: string;
	cause?: string;
	status?: number | null;
}

interface ProbeResults {
	metadata: ProbedMedia;
	trackSpans: TrackSpans;
	fastestFrameRate: number | null;
}

const DEFAULT_MEMORY_LIMIT_MB = 1024;
const MIN_MEMORY_LIMIT_MB = 128;
const UNREADABLE_MESSAGE = "Media input could not be read";

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

function failureToError(failure: ProbeWorkerFailure): Error {
	if (failure.kind === "policy") {
		// The class adds its own prefix to the reason it is given.
		const error = new MediaInputPolicyError("");
		error.message = failure.message;
		return error;
	}
	if (failure.kind === "address") return new MediaAddressError(failure.message);
	if (failure.kind === "not-accessible") {
		return new MediaInputNotAccessibleError(failure.status ?? null);
	}
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

const pool = createWorkerPool<
	Omit<ProbeWorkerRequest, "id">,
	ProbeWorkerFailure
>({
	entry: join(import.meta.dir, "media-probe-worker.ts"),
	env: () => childProcessEnv(process.env),
	memoryLimitMB: () => probeMemoryLimitMB(),
	toError: failureToError,
	memoryError: () =>
		new UnreadableMediaInputError(UNREADABLE_MESSAGE, {
			cause: "reading it needs more memory than a probe may use",
		}),
	faultError: () =>
		new UnreadableMediaInputError(UNREADABLE_MESSAGE, {
			cause: "the parser stopped on this file",
		}),
	faultExitCode: PARSER_FAULT_EXIT_CODE,
	maxWorkers: () => getMaxConcurrentProbeOperations(),
	label: "probe worker",
});

export const getProbeWorkerStats = pool.stats;
export const stopProbeWorkers = pool.stop;

// Starts the first worker ahead of the first probe.
export function warmProbeWorkers(): void {
	if (probeIsolationEnabled()) pool.warm();
}

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

function inWorker<Op extends ProbeWorkerOp>(
	op: Op,
	path: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ProbeResults[Op]> {
	return pool.run(
		{
			op,
			path,
			internalMediaHosts: process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS ?? null,
		},
		timeoutMs,
		signal,
	) as Promise<ProbeResults[Op]>;
}

let startFailureLogged = false;

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
			if (!(error instanceof WorkerLostError)) throw error;
			return await inWorker(op, path, timeoutMs, signal);
		}
	} catch (error) {
		if (!(error instanceof WorkerStartError)) throw error;
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

/// What the editor's own media reads say about the connection, so background
/// downloads (waveforms) only use it while playback and seeks don't need it.

const DECAY_MS = 5000;
const IDLE_MS = 150;
const STALLED_READ_MS = 10_000;
const MIN_WINDOW_BYTES = 128 * 1024;
const MAX_WINDOW_BYTES = 4 * 1024 * 1024;
/// How long one background read may hold the connection before a media read
/// can have it back.
const WINDOW_SECONDS = 0.5;

let inFlight = 0;
let busySince: number | null = null;
let busyMs = 0;
let bytes = 0;
let decayedAt = 0;
let idleSince = 0;
const idleWaiters = new Set<() => void>();

/// What the connection itself delivers, for telling people how it is doing:
/// only the time media reads spend waiting on the network counts, so a reader
/// that stops pulling doesn't make a fast connection look slow.
const LINK_DECAY_MS = 5000;
const LATENCY_SAMPLES = 8;
const LATENCY_MAX_AGE_MS = 30_000;
let waiting = 0;
let waitingSince: number | null = null;
let waitMs = 0;
let waitBytes = 0;
let linkDecayedAt = 0;
const latencies: Array<{ at: number; ms: number }> = [];

function decayLink(now: number) {
	const factor = Math.exp(-(now - linkDecayedAt) / LINK_DECAY_MS);
	waitMs *= factor;
	waitBytes *= factor;
	linkDecayedAt = now;
}

function waitStarted() {
	if (waiting++ === 0) waitingSince = performance.now();
}

function waitEnded(byteLength: number) {
	const now = performance.now();
	decayLink(now);
	waitBytes += byteLength;
	if (--waiting > 0) return;
	if (waitingSince !== null) waitMs += now - waitingSince;
	waitingSince = null;
}

async function timedRead(reader: ReadableStreamDefaultReader<Uint8Array>) {
	waitStarted();
	let byteLength = 0;
	try {
		const next = await reader.read();
		if (!next.done) byteLength = next.value.byteLength;
		return next;
	} finally {
		waitEnded(byteLength);
	}
}

function recordLatency(ms: number) {
	latencies.push({ at: performance.now(), ms });
	if (latencies.length > LATENCY_SAMPLES) latencies.shift();
}

function decay(now: number) {
	const factor = Math.exp(-(now - decayedAt) / DECAY_MS);
	bytes *= factor;
	busyMs *= factor;
	decayedAt = now;
}

function started() {
	if (inFlight++ === 0) busySince = performance.now();
}

function finished() {
	if (--inFlight > 0) return;
	const now = performance.now();
	decay(now);
	if (busySince !== null) busyMs += now - busySince;
	busySince = null;
	idleSince = now;
	for (const wake of [...idleWaiters]) wake();
}

/// Counts a media read from its request until its body ends, fails or is
/// cancelled; `abandon` ends one that never got a body.
export function startMediaRead(signal?: AbortSignal) {
	started();
	const requestedAt = performance.now();
	let done = false;
	// A body its reader stops pulling without cancelling stops counting
	// after a while, so it can't hold background downloads off for good.
	let stalled: ReturnType<typeof setTimeout> | undefined;
	const finish = () => {
		if (done) return;
		done = true;
		clearTimeout(stalled);
		signal?.removeEventListener("abort", finish);
		finished();
	};
	const watch = () => {
		clearTimeout(stalled);
		stalled = setTimeout(finish, STALLED_READ_MS);
	};
	signal?.addEventListener("abort", finish, { once: true });
	return {
		abandon: finish,
		body(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
			recordLatency(performance.now() - requestedAt);
			const reader = body.getReader();
			watch();
			return new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						watch();
						const next = await timedRead(reader);
						if (next.done) {
							finish();
							controller.close();
							return;
						}
						decay(performance.now());
						bytes += next.value.byteLength;
						controller.enqueue(next.value);
					} catch (cause) {
						finish();
						controller.error(cause);
					}
				},
				cancel(reason) {
					finish();
					return reader.cancel(reason);
				},
			});
		},
	};
}

/// Bytes a second the media reads have been getting while any was running,
/// or null before there is enough to tell.
export function mediaBytesPerSecond() {
	const now = performance.now();
	decay(now);
	const busy = busyMs + (busySince === null ? 0 : now - busySince);
	return busy >= 250 && bytes >= 64 * 1024 ? bytes / (busy / 1000) : null;
}

/// Resolves once no media read has run for a moment, with the size a
/// background read may take so it gives the connection back quickly.
export function whenMediaReadsIdle(signal?: AbortSignal): Promise<number> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const check = () => {
			if (signal?.aborted) {
				cleanup();
				reject(signal.reason ?? new DOMException("Canceled", "AbortError"));
				return;
			}
			if (inFlight > 0) return;
			const wait = idleSince + IDLE_MS - performance.now();
			if (wait > 0) {
				clearTimeout(timer);
				timer = setTimeout(check, wait);
				return;
			}
			cleanup();
			const rate = mediaBytesPerSecond();
			resolve(
				rate === null
					? MAX_WINDOW_BYTES
					: Math.max(
							MIN_WINDOW_BYTES,
							Math.min(MAX_WINDOW_BYTES, rate * WINDOW_SECONDS),
						),
			);
		};
		const cleanup = () => {
			clearTimeout(timer);
			idleWaiters.delete(check);
			signal?.removeEventListener("abort", check);
		};
		idleWaiters.add(check);
		signal?.addEventListener("abort", check, { once: true });
		check();
	});
}

/// `max` bytes on a fast connection, or what it delivers in `seconds` when
/// that is less, never under `min`: how much to read ahead or past a seek
/// target before it costs more waiting than it saves.
export function connectionBytes(max: number, seconds: number, min: number) {
	const rate = mediaBytesPerSecond();
	if (rate === null) return max;
	return Math.max(min, Math.min(max, Math.round(rate * seconds)));
}

/// Latency is the quickest recent response, since requests queued behind
/// others only ever look slower.
export function mediaConnectionSample(): {
	bitsPerSecond: number | null;
	latencyMs: number | null;
} {
	const now = performance.now();
	decayLink(now);
	const waited = waitMs + (waitingSince === null ? 0 : now - waitingSince);
	const enough =
		waitBytes >= 256 * 1024 ||
		(waited >= 1000 && waitBytes >= 16 * 1024) ||
		// A read that has had next to nothing for seconds is evidence too.
		waited >= 4000;
	let latencyMs: number | null = null;
	for (const sample of latencies) {
		if (now - sample.at > LATENCY_MAX_AGE_MS) continue;
		latencyMs = latencyMs === null ? sample.ms : Math.min(latencyMs, sample.ms);
	}
	return {
		bitsPerSecond: enough
			? (waitBytes * 8) / (Math.max(waited, 1) / 1000)
			: null,
		latencyMs,
	};
}

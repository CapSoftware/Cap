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
			const reader = body.getReader();
			watch();
			return new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						watch();
						const next = await reader.read();
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

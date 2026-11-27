import type { Input } from "mediabunny";
import { connectionBytes } from "./browser-network-budget";
import {
	layoutFetch,
	layoutHeldEnd,
	MediaStorageError,
	NEAR_SEEK_BYTES,
	type RemoteMedia,
	releaseRemoteMedia,
	remoteMedia,
} from "./browser-remote-media";
import type { LayoutPiece } from "./fragmented-mp4-seek";

type SharedInput = {
	url: string;
	/// File offset of the fragment this input starts at; 0 reads the whole file.
	from: number;
	/// Earliest and latest source times this input has decoded, so a request
	/// inside or just past them needs no walk.
	startTime: number;
	reached: number;
	input: Promise<Input>;
	users: number;
	disposeTimer: ReturnType<typeof setTimeout> | null;
	/// A read through the Input failed. mediabunny keeps a failed metadata
	/// read as the answer to every later call, so no new user gets this
	/// Input; the next one opens a fresh Input over the same bytes in memory.
	failed: boolean;
};

/// Holds a short recording whole, so scrubbing it never refetches, and caps a
/// long one at the same size: playback reads forward through the file and
/// would otherwise fill a bigger cache with bytes already shown.
const CACHE_BYTES = 16 * 1024 * 1024;
/// How far past its latest read an input may fetch. mediabunny doubles its
/// read-ahead up to 8 MB at a time, so a paused seek could fetch more than the
/// cache holds and evict the start of what it fetched: the fragments the next
/// seek along the timeline walks, one round trip each.
const READ_AHEAD_BYTES = CACHE_BYTES / 4;
const READ_AHEAD_SECONDS = 3;
const MIN_READ_AHEAD_BYTES = 1024 * 1024;
/// Read-ahead for a read that continues no earlier one (a first frame, a seek).
/// mediabunny loads at least half a megabyte for those, which a paused seek on
/// a slow link waits behind for every file at once; reads that continue a
/// region still grow the way mediabunny grows them.
const RANDOM_READ_AHEAD_BYTES = 128 * 1024;
/// mediabunny's `URL_SOURCE_MIN_LOAD_AMOUNT`: the least its network profile
/// loads for any read. A profile reaching further than this past a read is
/// mediabunny extending a sequential run.
const MEDIABUNNY_MIN_LOAD = 512 * 1024;
/// The probe and the preview open the same file a moment apart; the input
/// outlives its last user briefly so the second one reuses what the first
/// read.
const LINGER_MS = 15_000;
const MAX_REGIONS_PER_URL = 3;

const shared = new Map<string, SharedInput[]>();

/// Retries for a UrlSource read through `layoutFetch`: storage errors come back
/// as error responses, which mediabunny fails on its own, so only a thrown
/// network failure reaches here, and a few quick retries are enough.
export function layoutRetryDelay(attempts: number, error: unknown) {
	if (error instanceof MediaStorageError || attempts > 3) return null;
	if (error instanceof DOMException && error.name === "AbortError") return null;
	return 0.5 * attempts;
}

type PrefetchProfile = (
	start: number,
	end: number,
	workers: unknown,
) => { start: number; end: number };

type ReadWorker = {
	startPos: unknown;
	currentPos: unknown;
	targetPos: unknown;
	running: unknown;
};

function workerList(value: unknown) {
	return Array.isArray(value) ? (value as ReadWorker[]) : [];
}

/// Whether a read of [start, end) touches a region a read worker has fetched
/// or is fetching, as sequential decoding does. True when mediabunny keeps no
/// worker list, so its own read-ahead applies unchanged.
function continuesRegion(workers: unknown, start: number, end: number) {
	if (!Array.isArray(workers)) return true;
	return workerList(workers).some(
		(worker) =>
			typeof worker.startPos === "number" &&
			typeof worker.targetPos === "number" &&
			worker.startPos <= end &&
			start <= worker.targetPos,
	);
}

/// Caps the read-ahead of a mediabunny UrlSource at `READ_AHEAD_BYTES` past
/// each read, and at `RANDOM_READ_AHEAD_BYTES` past one that continues no
/// earlier read. A read of bytes already in memory (`held` gives where they
/// end) reads ahead no further than them unless mediabunny is extending a
/// sequential run: the reads that open a file and draw its first frame are all
/// in the pinned head, and read-ahead past it would share the link with the
/// editor's own first download. The profile is internal to mediabunny; a
/// source without one is left as it is.
export function limitReadAhead(
	source: object,
	bytes = READ_AHEAD_BYTES,
	held?: (start: number, end: number) => number | null,
) {
	const options = (
		source as { _orchestrator?: { options?: { prefetchProfile?: unknown } } }
	)._orchestrator?.options;
	const profile = options?.prefetchProfile;
	if (!options || typeof profile !== "function") return;
	options.prefetchProfile = ((start, end, workers) => {
		const range = (profile as PrefetchProfile)(start, end, workers);
		const extending = range.end > Math.max(end, start + MEDIABUNNY_MIN_LOAD);
		const heldUntil = extending ? null : (held?.(start, end) ?? null);
		if (heldUntil !== null) {
			return {
				start: range.start,
				end: Math.max(end, Math.min(range.end, heldUntil)),
			};
		}
		// A slow connection spends seconds on read-ahead the next seek may not
		// use, and the next seek waits behind it.
		const ahead = connectionBytes(
			bytes,
			READ_AHEAD_SECONDS,
			Math.min(bytes, MIN_READ_AHEAD_BYTES),
		);
		const limit = continuesRegion(workers, start, end)
			? ahead
			: Math.min(ahead, RANDOM_READ_AHEAD_BYTES);
		return {
			start: range.start,
			end: Math.max(end, Math.min(range.end, end + limit)),
		};
	}) satisfies PrefetchProfile;
}

/// Where the mediabunny read worker now fetching from `start` will stop, or
/// null when the source keeps no such worker. The worker list is internal to
/// mediabunny, like the prefetch profile `limitReadAhead` adjusts.
export function workerTarget(source: object, start: number) {
	const workers = workerList(
		(source as { _orchestrator?: { workers?: unknown } })._orchestrator
			?.workers,
	);
	const worker =
		workers.find(
			(candidate) =>
				candidate.running === true && candidate.currentPos === start,
		) ?? workers.find((candidate) => candidate.currentPos === start);
	return typeof worker?.targetPos === "number" &&
		Number.isFinite(worker.targetPos) &&
		worker.targetPos > start
		? worker.targetPos
		: null;
}

/// A WebM cluster cut in two (`webmCutLayout`) has its key frame in the
/// first part, and mediabunny looks for the key frame before a time from the
/// latest cluster it has read that starts at or before it: for a time in the
/// second part, that part alone, which holds no key frame. The key frame
/// before such a time is the cut cluster's own. mediabunny keeps this lookup
/// internal, like the read-ahead `limitReadAhead` adjusts; false when it is
/// not where this expects it, and the cluster is then read whole.
export function keepCutKeyFrame(track: object, keyTime: number) {
	const backing = (track as { _backing?: { getKeyPacket?: unknown } })._backing;
	const lookup = backing?.getKeyPacket;
	if (!backing || typeof lookup !== "function") return false;
	const find = (timestamp: number, options: unknown): Promise<unknown> =>
		lookup.call(backing, timestamp, options);
	backing.getKeyPacket = async (timestamp: number, options: unknown) =>
		(await find(timestamp, options)) ??
		(timestamp >= keyTime ? find(keyTime, options) : null);
	return true;
}

async function readsInRanges(media: RemoteMedia) {
	const head = await media.head().catch(() => null);
	return head !== null && media.size !== null;
}

function openInput(
	url: string,
	media: RemoteMedia | null,
	from: number,
	target: number,
	onFailure: () => void,
) {
	return import("mediabunny").then(
		async ({ ALL_FORMATS, Input, UrlSource }) => {
			// Storage that ignores ranges or hides their extent is read the way
			// mediabunny reads any URL.
			if (!media || (from === 0 && !(await readsInRanges(media)))) {
				return new Input({
					formats: ALL_FORMATS,
					source: new UrlSource(url, {
						maxCacheSize: CACHE_BYTES,
						fetchFn: watchedFetch(onFailure),
					}),
				});
			}
			const open = (layout: LayoutPiece[]) => {
				const source: InstanceType<typeof UrlSource> = new UrlSource(url, {
					maxCacheSize: CACHE_BYTES,
					fetchFn: layoutFetch(
						media,
						layout,
						(start) => workerTarget(source, start),
						onFailure,
					) as typeof fetch,
					getRetryDelay: layoutRetryDelay,
				});
				limitReadAhead(
					source,
					media.readAhead ?? READ_AHEAD_BYTES,
					(start, end) => layoutHeldEnd(layout, media, start, end),
				);
				return new Input({ formats: ALL_FORMATS, source });
			};
			const start = from > 0 ? from : null;
			const layout = await media.layout(start, target);
			const input = open(layout);
			const cut = layout.find(
				(piece) => piece.kind === "bytes" && piece.cutKeyTime !== undefined,
			);
			if (cut?.kind !== "bytes" || cut.cutKeyTime === undefined) return input;
			const track = await input.getPrimaryVideoTrack().catch(() => null);
			if (!track || keepCutKeyFrame(track, cut.cutKeyTime)) return input;
			input.dispose();
			return open(await media.layout(start, target, false));
		},
	);
}

function dispose(entry: SharedInput) {
	const list = shared.get(entry.url);
	if (list) {
		const index = list.indexOf(entry);
		if (index >= 0) list.splice(index, 1);
		if (list.length === 0) shared.delete(entry.url);
	}
	void entry.input.then(
		(input) => input.dispose(),
		() => undefined,
	);
}

/// `fetch` that calls `onFailure` for an error status or a failed request
/// other than a canceled one.
function watchedFetch(onFailure: () => void): typeof fetch {
	return (input, init) =>
		fetch(input, init).then(
			(response) => {
				if (!response.ok && !init?.signal?.aborted) onFailure();
				return response;
			},
			(cause: unknown) => {
				if (!init?.signal?.aborted) onFailure();
				throw cause;
			},
		);
}

function markFailed(entry: SharedInput) {
	entry.failed = true;
	if (entry.users > 0) return;
	if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
	dispose(entry);
}

function entryFor(
	url: string,
	media: RemoteMedia | null,
	from: number,
	startTime: number,
	target = startTime,
) {
	let list = shared.get(url);
	if (!list) {
		list = [];
		shared.set(url, list);
	}
	let entry = list.find(
		(candidate) => candidate.from === from && !candidate.failed,
	);
	if (!entry) {
		const fresh: SharedInput = {
			url,
			from,
			startTime,
			reached: startTime,
			input: openInput(url, media, from, target, () => markFailed(fresh)),
			users: 0,
			disposeTimer: null,
			failed: false,
		};
		entry = fresh;
		list.push(entry);
		const created = entry;
		entry.input.catch(() => {
			if (created.disposeTimer) clearTimeout(created.disposeTimer);
			dispose(created);
		});
		const regions = list.filter((candidate) => candidate.from > 0);
		if (regions.length > MAX_REGIONS_PER_URL) {
			const idle = regions.find(
				(candidate) => candidate.users === 0 && candidate !== created,
			);
			if (idle) {
				if (idle.disposeTimer) clearTimeout(idle.disposeTimer);
				dispose(idle);
			}
		}
	}
	return entry;
}

export type MediaInputLease = {
	input: Input;
	/// Source time this input starts at; earlier times need another input.
	startTime: number;
	/// Records that the input has decoded up to `time`.
	reached: (time: number) => void;
	/// Whether this input reaches `time` without a long walk from its start.
	covers: (time: number) => Promise<boolean>;
	release: () => void;
};

async function lease(
	entry: SharedInput,
	media: RemoteMedia | null,
): Promise<MediaInputLease> {
	entry.users++;
	if (entry.disposeTimer) {
		clearTimeout(entry.disposeTimer);
		entry.disposeTimer = null;
	}
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		entry.users--;
		if (entry.users > 0) return;
		if (entry.failed) {
			dispose(entry);
			return;
		}
		entry.disposeTimer = setTimeout(() => {
			entry.disposeTimer = null;
			if (entry.users === 0) dispose(entry);
		}, LINGER_MS);
	};
	try {
		const input = await entry.input;
		return {
			input,
			startTime: entry.startTime,
			reached: (time) => {
				if (time > entry.reached) entry.reached = time;
			},
			covers: (time) => reaches(entry, media, time),
			release,
		};
	} catch (cause) {
		release();
		throw cause;
	}
}

async function reaches(
	entry: SharedInput,
	media: RemoteMedia | null,
	time: number,
) {
	if (time < entry.startTime - 0.000001) return false;
	if (time <= entry.reached || !media) return true;
	if (media.size === null) return true;
	const rate = await media.bytesPerSecond();
	return rate === null || (time - entry.reached) * rate <= NEAR_SEEK_BYTES * 2;
}

/// One mediabunny Input per recording URL for the whole page, so the preview's
/// decoder and one-off frame reads (clip thumbnails) share the bytes and the
/// fragment positions already read instead of each walking the file again.
/// Call `release` once done; the Input closes a little after its last user
/// releases it.
export async function acquireMediaInput(url: string) {
	const media = remoteMedia(url);
	return lease(entryFor(url, media, 0, 0), media);
}

/// An Input that reaches `time` cheaply. Recordings carry no fragment index
/// and mediabunny finds a time by reading every fragment before it, so a
/// seek far past what an input has read starts a new input at a fragment
/// near the target instead (a virtual file of the recording's init bytes and
/// everything from that fragment on).
export async function acquireMediaInputAt(
	url: string,
	time: number,
	signal?: AbortSignal,
	scrubbing = false,
): Promise<MediaInputLease> {
	const media = remoteMedia(url);
	// A seek further than a short read from what an input has decoded enters
	// the file part-way, however small the file: walking a 16 MB camera file
	// to its end takes over ten seconds at 10 Mbps.
	if (!media || media.size === null) return acquireMediaInput(url);
	const candidates = (shared.get(url) ?? [])
		.filter((entry) => !entry.failed)
		.sort((a, b) => b.startTime - a.startTime);
	for (const entry of candidates) {
		if (
			(await reaches(entry, media, time)) &&
			shared.get(url)?.includes(entry)
		) {
			return lease(entry, media);
		}
	}
	const kind = await media.videoSeekKind();
	if (!kind) return acquireMediaInput(url);
	const point = await media
		.locate(time, signal, kind, scrubbing)
		.catch((cause: unknown) => {
			if (signal?.aborted) throw cause;
			return null;
		});
	const first = await media.firstEntry(kind).catch(() => null);
	if (
		!point ||
		!first ||
		point.offset <= first.offset ||
		point.time > time + 0.000001
	) {
		return acquireMediaInput(url);
	}
	return lease(entryFor(url, media, point.offset, point.time, time), media);
}

/// Registers a recording's size from the editor's sources and starts reading
/// its head and tail, which the probe and first frame need.
export function warmMediaSource(url: string, size: number | null) {
	remoteMedia(url, size)?.warm();
}

export function releaseMediaSources() {
	for (const list of [...shared.values()]) {
		for (const entry of [...list]) {
			if (entry.users > 0) continue;
			if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
			dispose(entry);
		}
	}
	releaseRemoteMedia();
}

export function mediaSource(
	url: string,
	size?: number | null,
	durationHint?: number | null,
	contentType?: string | null,
) {
	return remoteMedia(url, size, durationHint, contentType);
}

import type { Input } from "mediabunny";
import {
	layoutFetch,
	MediaStorageError,
	NEAR_SEEK_BYTES,
	type RemoteMedia,
	releaseRemoteMedia,
	remoteMedia,
} from "./browser-remote-media";

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
};

/// Holds a short recording whole, so scrubbing it never refetches, and caps a
/// long one at the same size: playback reads forward through the file and
/// would otherwise fill a bigger cache with bytes already shown.
const CACHE_BYTES = 16 * 1024 * 1024;
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

async function readsInRanges(media: RemoteMedia) {
	const head = await media.head().catch(() => null);
	return head !== null && media.size !== null;
}

function openInput(url: string, media: RemoteMedia | null, from: number) {
	return import("mediabunny").then(
		async ({ ALL_FORMATS, Input, UrlSource }) => {
			// Storage that ignores ranges or hides their extent is read the way
			// mediabunny reads any URL.
			if (!media || (from === 0 && !(await readsInRanges(media)))) {
				return new Input({
					formats: ALL_FORMATS,
					source: new UrlSource(url, { maxCacheSize: CACHE_BYTES }),
				});
			}
			const layout = await media.layout(from > 0 ? from : null);
			return new Input({
				formats: ALL_FORMATS,
				source: new UrlSource(url, {
					maxCacheSize: CACHE_BYTES,
					fetchFn: layoutFetch(media, layout) as typeof fetch,
					getRetryDelay: layoutRetryDelay,
				}),
			});
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

function entryFor(
	url: string,
	media: RemoteMedia | null,
	from: number,
	startTime: number,
) {
	let list = shared.get(url);
	if (!list) {
		list = [];
		shared.set(url, list);
	}
	let entry = list.find((candidate) => candidate.from === from);
	if (!entry) {
		entry = {
			url,
			from,
			startTime,
			reached: startTime,
			input: openInput(url, media, from),
			users: 0,
			disposeTimer: null,
		};
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
	if (media.size === null || media.size <= CACHE_BYTES) return true;
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
): Promise<MediaInputLease> {
	const media = remoteMedia(url);
	// A file that fits in the decoder's cache is read once by the first walk
	// through it, after which every seek is free; only larger files are
	// entered part-way.
	if (!media || media.size === null || media.size <= CACHE_BYTES) {
		return acquireMediaInput(url);
	}
	const candidates = [...(shared.get(url) ?? [])].sort(
		(a, b) => b.startTime - a.startTime,
	);
	for (const entry of candidates) {
		if (
			(await reaches(entry, media, time)) &&
			shared.get(url)?.includes(entry)
		) {
			return lease(entry, media);
		}
	}
	const point = await media.locate(time, signal).catch((cause: unknown) => {
		if (signal?.aborted) throw cause;
		return null;
	});
	const first = await media.firstFragment().catch(() => null);
	if (
		!point ||
		!first ||
		point.offset <= first.offset ||
		point.time > time + 0.000001
	) {
		return acquireMediaInput(url);
	}
	return lease(entryFor(url, media, point.offset, point.time), media);
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
) {
	return remoteMedia(url, size, durationHint);
}

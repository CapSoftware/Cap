import { startMediaRead } from "./browser-network-budget";
import { endsAfterFragments } from "./fragmented-mp4-duration";
import {
	boxAt,
	children,
	emptyMfra,
	type FragmentPoint,
	fragmentsIn,
	type LayoutPiece,
	layoutSize,
	type Mp4SeekInfo,
	mfraPoints,
	mp4SeekInfo,
	nextFragmentProbe,
	planLayoutRead,
	trailingMfra,
	virtualLayout,
} from "./fragmented-mp4-seek";
import {
	clustersIn,
	type WebmClusterCut,
	type WebmCutStep,
	webmClusterCut,
	webmCutLayout,
	webmSeekInfo,
	webmTrailingCues,
} from "./webm-cluster-seek";

/// The first read of a file when its bitrate is unknown: half a megabyte holds
/// the `moov` and the first fragments of a recording.
const HEAD_BYTES = 512 * 1024;
const MIN_HEAD = 128 * 1024;
/// WebM audio keeps its headers in the first few hundred bytes and usually
/// writes a cluster about every second, so this much of its start or end holds
/// what the probe, the audio stream and a seek need. A seek reads more of the
/// end when the last cluster starts further back.
const AUDIO_WEBM_BYTES = 64 * 1024;
const MIN_TAIL = 256 * 1024;
const MAX_FIRST_TAIL = 4 * 1024 * 1024;
const MAX_KEPT_TAIL = 8 * 1024 * 1024;
const INDEX_BYTES_PER_SECOND = 10;

/// Tail lengths to try in turn when the first tail read holds no whole
/// fragment (a file cut short mid-fragment, or one with an index after its
/// last fragment). A first read sized from the file's bitrate holds about one
/// fragment, so twice and eight times it follow; a guessed one (no duration
/// known) jumps to a few megabytes, as fragments of any size fit.
export function tailSteps(first: number, sized: boolean) {
	return sized
		? [first, first * 2, first * 8]
		: [first, 2 * 1024 * 1024, MAX_KEPT_TAIL];
}

const FIRST_CHUNK = 512 * 1024;
const MAX_CHUNK = 8 * 1024 * 1024;
const PROBE_WINDOW = 256 * 1024;
const MAX_PROBE_SCAN = 4 * 1024 * 1024;
const MAX_PROBES = 10;
/// A seek reads forward from the entry point it starts at; this much reading
/// is cheaper than another probe on a slow connection. Audio needs far fewer
/// bytes per second, so its entry point is found closer to the target.
export const NEAR_SEEK_BYTES = 1024 * 1024;
const NEAR_AUDIO_BYTES = 128 * 1024;

const MAX_ENTRIES = 24;

/// A WebM cluster read for a decoder ends this many video frames past the
/// one it wants: a decoder shows a frame once the next one is in, and some
/// hold one or two more.
const CUT_FRAMES_AFTER = 3;
/// Read past the estimated cut, so a short estimate rarely costs another
/// round trip.
const CUT_MARGIN = 64 * 1024;
const CUT_OVERSHOOT = 1.15;
const MAX_CUT_READS = 8;
/// Bytes past a block the cut still needs, in seconds of the cluster's
/// bitrate: the frames after the one a decoder wants.
const CUT_FRAMES_SECONDS = 0.15;
const MAX_CUT_BYTES = 32 * 1024 * 1024;
/// Probe windows kept so the decoder that starts at a found fragment reads
/// its first bytes from memory.
const RECENT_WINDOWS = 8;

/// Bytes for the first read of a file's tail: its last fragment (recordings
/// write one every second or two) when the average bitrate is known. A read
/// that falls short is extended by only the bytes before it, so this stays
/// small: a camera at several megabits a second would otherwise read seconds
/// of video nothing plays before the first frame.
export function firstTailBytes(size: number | null, duration: number | null) {
	if (size === null || duration === null || !(duration > 0)) return MIN_TAIL;
	const twoSeconds = (size / duration) * 2;
	// The recorder's index follows the last fragment: 11 bytes for each of
	// the fragments it writes every 1.4 to 2 seconds.
	const index = Math.ceil((duration * INDEX_BYTES_PER_SECOND) / 4096) * 4096;
	const rounded = Math.ceil(twoSeconds / 65536) * 65536 + index;
	return Math.max(MIN_TAIL, Math.min(MAX_FIRST_TAIL, rounded));
}

/// Bytes for the first read of a file's start: the `moov`, the first
/// fragment's header and its key frame, which the first frame decodes. About a
/// second of the average bitrate holds a key frame; a short read costs one more
/// round trip for the rest of it, never extra bytes, while every byte of a
/// longer one shares the link with the editor's own first download.
export function firstHeadBytes(size: number | null, duration: number | null) {
	if (size === null || duration === null || !(duration > 0)) return HEAD_BYTES;
	const second = Math.ceil(size / duration / 65536) * 65536;
	return Math.max(MIN_HEAD, Math.min(HEAD_BYTES, second));
}

export function mp4NeedsNoTail(head: Uint8Array) {
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	let offset = 0;
	while (offset < head.byteLength) {
		const box = boxAt(view, offset, head.byteLength);
		if (!box) return false;
		if (box.type === "moov") {
			// A fragmented recording's moov holds only its sample descriptions,
			// a few kilobytes; one past the head holds a whole sample table.
			if (box.end > head.byteLength) return box.end - box.start > MIN_HEAD;
			const parts = children(view, box);
			return (
				box.end <= head.byteLength &&
				parts !== null &&
				!parts.some((child) => child.type === "mvex")
			);
		}
		if (box.type === "mdat" || box.type === "moof") return false;
		offset = box.end;
	}
	return false;
}

export type RangeResponse = {
	body: ReadableStream<Uint8Array>;
	start: number;
	end: number;
	size: number;
};

function canceled(signal: AbortSignal | null | undefined) {
	return signal?.reason instanceof Error
		? signal.reason
		: new DOMException("Canceled", "AbortError");
}

function bytesStream(bytes: Uint8Array) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (bytes.byteLength > 0) controller.enqueue(bytes);
			controller.close();
		},
	});
}

/// A storage response that cannot serve a ranged read: an error status, a
/// server that ignores ranges, or a range the browser cannot read. `status` is
/// what a caller should report upstream (502 when the response itself was
/// fine but unusable).
export class MediaStorageError extends Error {
	constructor(readonly status: number) {
		super(`Editor media storage returned ${status}`);
		this.name = "MediaStorageError";
	}
}

/// Where a 206 response to `bytes=start-(requestedEnd - 1)` ends and how big the
/// file is. Content-Range is authoritative; buckets that don't expose it to
/// the page fall back to Content-Length and the size already known.
export function rangeResponseExtent(
	headers: Headers,
	start: number,
	requestedEnd: number,
	knownSize: number | null,
) {
	const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(
		headers.get("Content-Range") ?? "",
	);
	const lengthHeader = headers.get("Content-Length");
	const length = lengthHeader === null ? null : Number(lengthHeader);
	let end: number | null = null;
	let size = knownSize;
	if (match) {
		if (Number(match[1]) !== start) return null;
		end = Number(match[2]) + 1;
		if (match[3] !== "*") size = Number(match[3]);
		if (
			length !== null &&
			Number.isSafeInteger(length) &&
			length !== end - start
		) {
			return null;
		}
	} else if (length !== null && Number.isSafeInteger(length) && length > 0) {
		end = start + length;
	}
	if (
		end === null ||
		size === null ||
		!Number.isSafeInteger(size) ||
		size < 1 ||
		end <= start ||
		end > requestedEnd ||
		end > size
	) {
		return null;
	}
	return { end, size };
}

async function readAll(body: ReadableStream<Uint8Array>, length: number) {
	const out = new Uint8Array(length);
	const reader = body.getReader();
	let filled = 0;
	try {
		while (filled < length) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = Math.min(value.byteLength, length - filled);
			out.set(value.subarray(0, take), filled);
			filled += take;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return out.subarray(0, filled);
}

/// A fragment search and the callers waiting on it. Once every caller has
/// given up it stops reading after `ORPHAN_GRACE_MS`, unless a caller asks for
/// the same time again first (as a scrub that redraws the same frame does);
/// a caller that can't give up keeps it running to the end.
type Locating = {
	result: Promise<FragmentPoint | null>;
	controller: AbortController;
	waiting: number;
	keep: boolean;
	orphanTimer: ReturnType<typeof setTimeout> | undefined;
};

const ORPHAN_GRACE_MS = 250;

type Pinned = { start: number; end: number; bytes: Promise<Uint8Array | null> };

/// Bytes of the file kept in memory from `start`; `filling` while a read is
/// still adding to them, up to its `end`.
type HeldWindow = {
	start: number;
	bytes: Uint8Array;
	filling?: { end: number; done: Promise<void> };
};

/// Cluster cuts being read for a decoder (`webmCut`), which the bytes past
/// any cut (the rest of a cluster, played later) wait behind.
let cutsReading = 0;
let cutsSettled: (() => void) | null = null;
let cutsIdle: Promise<void> | null = null;

function cutStarted() {
	cutsReading++;
}

function cutEnded() {
	if (--cutsReading > 0) return;
	cutsSettled?.();
	cutsSettled = null;
	cutsIdle = null;
}

/// Settles once no cluster cut is being read, or when `signal` aborts.
export function afterClusterCuts(signal?: AbortSignal): Promise<void> {
	if (cutsReading === 0) return Promise.resolve();
	if (!cutsIdle) {
		cutsIdle = new Promise<void>((resolve) => {
			cutsSettled = resolve;
		});
	}
	const idle = cutsIdle;
	if (!signal) return idle;
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => reject(canceled(signal));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		idle.then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

export type SeekKind = "mp4" | "webm";

type Scanner = {
	nearBytes: number;
	scan: (
		window: Uint8Array,
		start: number,
	) => { points: FragmentPoint[]; resumeAt: number };
	seeds: FragmentPoint[];
};

type SeekIndex = {
	known: FragmentPoint[];
	locating: Map<number, Locating>;
	scanner: Promise<Scanner | null> | null;
};

/// Adds decodable entry points to `known` (kept sorted by offset); true when
/// any were new.
function remember(known: FragmentPoint[], points: FragmentPoint[]) {
	const before = known.length;
	for (const point of points) {
		if (!point.keyframe || !point.relocatable) continue;
		if (known.some((entry) => entry.offset === point.offset)) continue;
		known.push(point);
	}
	known.sort((a, b) => a.offset - b.offset);
	return known.length > before;
}

/// One recording file in storage, shared by everything on the page that reads
/// it: the metadata probe, the preview decoders and thumbnails. It keeps the
/// head and tail of the file (read in parallel as soon as the size is known,
/// since every reader needs both), reads everything else as bounded ranges so
/// finished requests leave their connection open for the next one, and
/// remembers the fragments it has seen so seeks can skip ahead.
export class RemoteMedia {
	private readonly pinned: Pinned[] = [];
	/// Pinned blocks that have arrived, for questions that must be answered
	/// without waiting.
	private readonly held: { start: number; bytes: Uint8Array }[] = [];
	private readonly recent: HeldWindow[] = [];
	private sizeValue: number | null;
	private sizePromise: Promise<number> | null = null;
	private headPromise: Promise<Uint8Array | null> | null = null;
	private pinnedTail: {
		length: number;
		bytes: Promise<Uint8Array | null>;
	} | null = null;
	private seekPromise: Promise<{
		info: Mp4SeekInfo;
		trailer: Uint8Array | null;
		tailPoints: FragmentPoint[];
		/// Key frame fragments the recording's `mfra` lists.
		indexPoints: FragmentPoint[];
		/// End of the last whole fragment, where a virtual file stops.
		end: number;
	} | null> | null = null;
	/// Where a WebM's appended Cues start, which a virtual file stops before.
	private webmCuesStart: number | null = null;
	/// The cut of the first cluster for a whole-file decoder, found once.
	private firstCut: Promise<WebmClusterCut | null> | null = null;
	private readonly indexes = new Map<SeekKind, SeekIndex>();
	private rate: number | null | undefined;
	private durationHint: number | null = null;
	private audioWebm = false;
	lastUsed = Date.now();

	constructor(
		readonly url: string,
		size: number | null,
	) {
		this.sizeValue = size;
	}

	learnDuration(duration: number) {
		if (this.durationHint === null && duration > 0)
			this.durationHint = duration;
	}

	/// Sizes the first reads of the file for its format; only before they start.
	learnContentType(contentType: string) {
		if (this.headPromise || this.pinnedTail) return;
		this.audioWebm = contentType.startsWith("audio/webm");
	}

	/// How many bytes mediabunny may read past what it asked for, for a file
	/// it reads only to find its format, or null for the default.
	get readAhead() {
		return this.audioWebm ? AUDIO_WEBM_BYTES : null;
	}

	/// The length of the first tail read, which later reads of that length or
	/// less reuse.
	pinnedTailBytes() {
		return this.audioWebm
			? AUDIO_WEBM_BYTES
			: firstTailBytes(this.sizeValue, this.durationHint);
	}

	/// The tail lengths the seek index and the probe try in turn.
	tailSteps() {
		return tailSteps(
			this.pinnedTailBytes(),
			this.audioWebm || (this.sizeValue !== null && this.durationHint !== null),
		);
	}

	get size() {
		return this.sizeValue;
	}

	learnSize(size: number) {
		if (this.sizeValue === null) this.sizeValue = size;
	}

	/// Starts reading the head and tail. An unfragmented MP4 with its `moov`
	/// up front never uses its tail.
	warm() {
		const tail = new AbortController();
		void this.head()
			.then((head) => {
				if (head && !this.audioWebm && mp4NeedsNoTail(head)) tail.abort();
			})
			.catch(() => undefined);
		void this.fileSize()
			.then(() => this.tail(this.pinnedTailBytes(), tail.signal))
			.catch(() => undefined);
	}

	private async network(start: number, end: number, signal?: AbortSignal) {
		let response: Response;
		const read = startMediaRead(signal);
		try {
			// Chrome's HTTP cache lets one request at a time use a URL's entry,
			// so a second range of the same file waits for the first to finish.
			// Each editor session signs its URLs afresh, so nothing a later
			// visit could reuse is lost by skipping the cache.
			response = await fetch(this.url, {
				headers: { Range: `bytes=${start}-${end - 1}` },
				cache: "no-store",
				signal,
			});
		} catch (cause) {
			read.abandon();
			if (signal?.aborted) throw cause;
			throw new MediaStorageError(502);
		}
		const extent =
			response.status === 206
				? rangeResponseExtent(response.headers, start, end, this.sizeValue)
				: null;
		if (!extent || !response.body) {
			read.abandon();
			await response.body?.cancel().catch(() => undefined);
			throw new MediaStorageError(response.ok ? 502 : response.status);
		}
		if (this.sizeValue === null) this.sizeValue = extent.size;
		return {
			body: read.body(response.body),
			start,
			end: extent.end,
			size: extent.size,
		} satisfies RangeResponse;
	}

	private pin(start: number, end: number, signal?: AbortSignal) {
		const existing = this.pinned.find(
			(block) => block.start === start && block.end === end,
		);
		if (existing) return existing.bytes;
		const block: Pinned = {
			start,
			end,
			bytes: this.network(start, end, signal).then(async (response) => {
				const bytes = await readAll(response.body, response.end - start);
				return bytes.byteLength === response.end - start ? bytes : null;
			}),
		};
		this.pinned.push(block);
		block.bytes.then(
			(bytes) => {
				if (bytes) this.held.push({ start, bytes });
				else this.unpin(block);
			},
			() => this.unpin(block),
		);
		return block.bytes;
	}

	private unpin(block: Pinned) {
		const index = this.pinned.indexOf(block);
		if (index >= 0) this.pinned.splice(index, 1);
	}

	/// End of the bytes held in memory (a pinned head or tail, or a recent
	/// probe window) that cover [start, end), or null when a read of them would
	/// go to the network.
	heldEnd(start: number, end: number) {
		for (const block of [...this.held, ...this.recent]) {
			const blockEnd = block.start + block.bytes.byteLength;
			if (block.start <= start && end <= blockEnd) return blockEnd;
		}
		return null;
	}

	head() {
		if (!this.headPromise) {
			const bytes = this.audioWebm
				? AUDIO_WEBM_BYTES
				: firstHeadBytes(this.sizeValue, this.durationHint);
			const end =
				this.sizeValue === null ? bytes : Math.min(bytes, this.sizeValue);
			const head = this.pin(0, end);
			this.headPromise = head;
			const forget = () => {
				if (this.headPromise === head) this.headPromise = null;
			};
			head.then((bytes) => {
				if (!bytes) forget();
			}, forget);
		}
		return this.headPromise;
	}

	fileSize() {
		if (this.sizeValue !== null) return Promise.resolve(this.sizeValue);
		if (!this.sizePromise) {
			this.sizePromise = this.head().then(() => {
				if (this.sizeValue === null) {
					throw new Error("Editor media size is unavailable");
				}
				return this.sizeValue;
			});
			this.sizePromise.catch(() => {
				this.sizePromise = null;
			});
		}
		return this.sizePromise;
	}

	/// At least the last `length` bytes of the file (all of it when shorter).
	/// A longer read fetches only the bytes before the tail already held and
	/// is kept in its place (up to `MAX_KEPT_TAIL`), so the probe and the seek
	/// index that both need it read it once.
	tail(length: number, signal?: AbortSignal): Promise<Uint8Array | null> {
		const pinned = this.pinnedTail;
		if (pinned && pinned.length >= length) return pinned.bytes;
		if (pinned) {
			const longer = Promise.all([
				this.fileSize(),
				pinned.bytes.catch(() => null),
			]).then(async ([size, last]) => {
				const start = Math.max(0, size - length);
				const pinnedStart = last ? size - last.byteLength : size;
				const response = await this.network(start, pinnedStart);
				const front = await readAll(response.body, pinnedStart - start);
				if (!last || front.byteLength !== pinnedStart - start) return front;
				const whole = new Uint8Array(size - start);
				whole.set(front);
				whole.set(last, front.byteLength);
				return whole;
			});
			if (length > MAX_KEPT_TAIL) return longer;
			const entry = { length, bytes: longer };
			this.pinnedTail = entry;
			const restore = () => {
				if (this.pinnedTail === entry) this.pinnedTail = pinned;
			};
			longer.then((bytes) => {
				if (!bytes || bytes.byteLength < Math.min(length, this.sizeValue ?? 0))
					restore();
			}, restore);
			return longer;
		}
		const wanted = Math.max(length, this.pinnedTailBytes());
		const entry = {
			length: wanted,
			bytes: this.fileSize().then((size) =>
				this.pin(Math.max(0, size - wanted), size, signal),
			),
		};
		this.pinnedTail = entry;
		const forget = () => {
			if (this.pinnedTail === entry) this.pinnedTail = null;
		};
		entry.bytes.then((bytes) => {
			if (!bytes) forget();
		}, forget);
		return entry.bytes;
	}

	/// A bounded read of [start, end) that uses the pinned head or tail when it
	/// covers the start; the response may stop early at a pinned block edge.
	async read(start: number, end: number, signal?: AbortSignal) {
		if (signal?.aborted) throw canceled(signal);
		this.lastUsed = Date.now();
		for (const block of this.pinned) {
			if (block.start <= start && start < block.end) {
				const bytes = await block.bytes.catch(() => null);
				if (signal?.aborted) throw canceled(signal);
				const size = this.sizeValue;
				if (bytes && size !== null && start < block.start + bytes.byteLength) {
					const stop = Math.min(end, block.start + bytes.byteLength);
					return {
						body: bytesStream(
							bytes.subarray(start - block.start, stop - block.start),
						),
						start,
						end: stop,
						size,
					} satisfies RangeResponse;
				}
			}
		}
		for (const window of this.recent) {
			const filling = window.filling;
			if (
				filling &&
				window.start <= start &&
				start >= window.start + window.bytes.byteLength &&
				start < filling.end
			) {
				await filling.done;
				if (signal?.aborted) throw canceled(signal);
				break;
			}
		}
		const size = this.sizeValue;
		for (const window of this.recent) {
			const windowEnd = window.start + window.bytes.byteLength;
			if (size !== null && window.start <= start && start < windowEnd) {
				const stop = Math.min(end, windowEnd);
				return {
					body: bytesStream(
						window.bytes.subarray(start - window.start, stop - window.start),
					),
					start,
					end: stop,
					size,
				} satisfies RangeResponse;
			}
		}
		let stop = end;
		for (const block of this.pinned) {
			if (block.start > start && block.start < stop) stop = block.start;
		}
		return this.network(start, stop, signal);
	}

	/// All of `start` to `end`: `read` answers with whatever one cached window
	/// or request covers, which can be only a few bytes at a window's edge.
	private async readFully(
		signal: AbortSignal | undefined,
		start: number,
		end: number,
	) {
		const out = new Uint8Array(end - start);
		let filled = 0;
		while (start + filled < end) {
			const response = await this.read(start + filled, end, signal);
			const bytes = await readAll(response.body, response.end - start - filled);
			if (bytes.byteLength === 0) break;
			out.set(bytes, filled);
			filled += bytes.byteLength;
		}
		return out.subarray(0, filled);
	}

	/// What seeking needs: the video track's timing, whether the file can
	/// take an empty `mfra` trailer (fragmented, ends in a whole fragment and
	/// at most the recorder's index), and the fragments that index lists. A
	/// virtual file stops before the index and ends in the empty one, so
	/// mediabunny never reads the real one. Null for anything else, which
	/// reads as before.
	seekLayout() {
		if (!this.seekPromise) {
			this.seekPromise = (async () => {
				const [head, size] = await Promise.all([this.head(), this.fileSize()]);
				if (!head) throw new MediaStorageError(502);
				const info = mp4SeekInfo(head);
				if (!info) return null;
				for (const length of this.tailSteps()) {
					const tail = await this.tail(length);
					if (!tail) return null;
					const tailStart = size - tail.byteLength;
					const mfra = trailingMfra(tail, info.videoTrackId);
					if (mfra?.entries?.length === 0) return null;
					if (mfra && !mfra.entries) {
						if (tailStart === 0) return null;
						continue;
					}
					const fragmentsEnd = size - (mfra?.size ?? 0);
					const body = tail.subarray(0, fragmentsEnd - tailStart);
					const points = fragmentsIn(body, tailStart, info).points.filter(
						(point) => point.end <= fragmentsEnd,
					);
					const last = points.at(-1);
					if (last && endsAfterFragments(body, last.end - tailStart)) {
						const first = fragmentsIn(head, 0, info).points[0];
						return {
							info,
							trailer: emptyMfra(),
							tailPoints: points,
							indexPoints: mfra?.entries
								? mfraPoints(
										mfra.entries,
										info.timescale,
										info.moovEnd,
										last.end,
										first?.relocatable ?? false,
									)
								: [],
							end: last.end,
						};
					}
					if (tailStart === 0) return null;
				}
				return {
					info,
					trailer: null,
					tailPoints: [],
					indexPoints: [],
					end: size,
				};
			})();
			this.seekPromise.catch(() => {
				this.seekPromise = null;
			});
		}
		return this.seekPromise;
	}

	/// Virtual file for a decoder: the whole recording, or (with `from`) the
	/// init bytes followed by the recording from the fragment at `from`.
	async layout(
		from: number | null,
		time = Number.NEGATIVE_INFINITY,
		cut = true,
	): Promise<LayoutPiece[]> {
		const size = await this.fileSize();
		const seek = await this.seekLayout().catch(() => null);
		if (!seek) {
			const webm = await this.webmLayout(from, time, size, cut);
			if (webm) return webm;
		}
		if (!seek || from === null) {
			return virtualLayout(null, 0, seek?.end ?? size, seek?.trailer ?? null);
		}
		const head = await this.head();
		if (!head) throw new Error("Editor media head is unavailable");
		return virtualLayout(
			head.subarray(0, seek.info.moovEnd),
			from,
			seek.end,
			seek.trailer,
		);
	}

	/// A live WebM's virtual file. A decoder entering at a cluster, or reading
	/// the whole file from its first, gets that cluster cut just past what it
	/// wants first (`webmCut`), since mediabunny loads a cluster whole before
	/// it returns any frame of it, and a screen recorded in Firefox writes
	/// clusters of several seconds and megabytes.
	private async webmLayout(
		from: number | null,
		time: number,
		size: number,
		cutClusters: boolean,
	) {
		const head = await this.head();
		const info = head && webmSeekInfo(head);
		if (!head || !info?.live) return null;
		const end = from === null ? size : (this.webmCuesStart ?? size);
		const point =
			info.videoTracks.length === 0 || !cutClusters
				? null
				: from === null
					? await this.firstEntry("webm").catch(() => null)
					: (this.indexes
							.get("webm")
							?.known.find((entry) => entry.offset === from) ?? null);
		let cut: WebmClusterCut | null = null;
		if (point && from === null) {
			if (!this.firstCut) {
				const pending = this.webmCut(point, Number.NEGATIVE_INFINITY);
				this.firstCut = pending;
				pending.catch(() => {
					if (this.firstCut === pending) this.firstCut = null;
				});
			}
			cut = await this.firstCut.catch(() => null);
		} else if (point) {
			cut = await this.webmCut(point, time).catch(() => null);
		}
		const init = head.subarray(0, info.initEnd);
		if (point && cut) {
			return webmCutLayout(
				from === null ? null : init,
				point.offset,
				cut,
				end,
				cut.end ?? this.clusterEnd(point.offset),
			);
		}
		if (from === null) return null;
		const layout = virtualLayout(init, from, end, null);
		const clusterEnd = this.clusterEnd(from);
		for (const piece of layout) {
			if (piece.kind === "remote" && clusterEnd !== null) {
				piece.burstEnd = clusterEnd;
			}
		}
		return layout;
	}

	/// Reads the WebM cluster that starts at `point` up to where a decoder
	/// that wants `time` can stop (see `webmClusterCut`), and keeps what it
	/// read for the decoder. The read is aimed at twice the cut's estimate from
	/// the cluster's bitrate and parsed as it arrives, so the cut is known as
	/// soon as its bytes are in, and the rest of the read fills in behind it
	/// for playback; a short one goes on from what it found. Null when the
	/// cluster can't be cut, which leaves it to be read whole.
	private async webmCut(
		point: FragmentPoint,
		time: number,
	): Promise<WebmClusterCut | null> {
		const [head, size] = await Promise.all([this.head(), this.fileSize()]);
		const info = head && webmSeekInfo(head);
		if (!info) return null;
		// A cut past where the next entry point starts is no cut at all.
		const limit = Math.min(
			size,
			this.webmCuesStart ?? size,
			this.clusterEnd(point.offset) ?? size,
			point.offset + MAX_CUT_BYTES,
		);
		const rate = (await this.clusterRate(point)) ?? 0;
		const margin = Math.max(CUT_MARGIN, rate * 0.2);
		const aim = (from: number, fromTime: number) =>
			from + Math.max(0, time - fromTime) * rate * CUT_OVERSHOOT + margin;
		const window: HeldWindow = { start: point.offset, bytes: new Uint8Array() };
		let buffer = new Uint8Array(0);
		let filled = 0;
		const append = (chunk: Uint8Array) => {
			if (filled + chunk.byteLength > buffer.byteLength) {
				const grown = new Uint8Array(
					Math.max(buffer.byteLength * 2, filled + chunk.byteLength),
				);
				grown.set(buffer.subarray(0, filled));
				buffer = grown;
			}
			buffer.set(chunk, filled);
			filled += chunk.byteLength;
			window.bytes = buffer.subarray(0, filled);
		};
		this.recent.unshift(window);
		this.recent.length = Math.min(this.recent.length, RECENT_WINDOWS);
		type Read = { response: Promise<RangeResponse>; end: number };
		const reads: Read[] = [];
		let asked = 0;
		// Each read past the first asks for at least as much again as the
		// network reads before it, so a cluster far off its estimate costs a
		// few round trips, not one per margin.
		let fetched = 0;
		const request = (start: number, wanted: number) => {
			const end = Math.min(
				limit,
				Math.max(start + 1, Math.ceil(wanted), start + fetched),
			);
			if (this.heldEnd(start, start + 1) === null) fetched += end - start;
			const response = this.read(start, end);
			response.catch(() => undefined);
			reads.push({ response, end });
			asked++;
		};
		const fillBehind = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
			const later = reads.splice(0);
			window.filling = {
				end: later.at(-1)?.end ?? point.offset + filled,
				done: (async () => {
					let current: typeof reader | null = reader;
					try {
						while (current) {
							const next = await current.read();
							if (!next.done) {
								append(next.value);
								continue;
							}
							const following = later.shift();
							const response = following && (await following.response);
							current =
								response && response.start === point.offset + filled
									? response.body.getReader()
									: null;
							if (!current)
								await response?.body.cancel().catch(() => undefined);
						}
					} catch {
						await current?.cancel().catch(() => undefined);
					} finally {
						for (const rest of later) {
							void rest.response.then(
								(response) => response.body.cancel(),
								() => undefined,
							);
						}
						window.filling = undefined;
					}
				})(),
			};
		};
		request(
			point.offset,
			Math.max(
				aim(point.offset, point.time),
				this.heldEnd(point.offset, point.offset + 1) ?? 0,
			),
		);
		cutStarted();
		try {
			for (let read = reads.shift(); read; read = reads.shift()) {
				const response = await read.response;
				const start = point.offset + filled;
				if (response.start !== start) {
					await response.body.cancel().catch(() => undefined);
					for (const rest of reads.splice(0)) {
						void rest.response.then(
							(stale) => stale.body.cancel(),
							() => undefined,
						);
					}
					if (start >= limit || asked >= MAX_CUT_READS) return null;
					request(start, start + margin);
					continue;
				}
				const reader = response.body.getReader();
				let step: WebmCutStep | null = null;
				let ended = false;
				for (;;) {
					const next = await reader.read();
					if (next.done) {
						ended = true;
						break;
					}
					append(next.value);
					step = webmClusterCut(
						window.bytes,
						point.offset,
						info,
						time,
						CUT_FRAMES_AFTER,
					);
					if (step?.kind !== "more") break;
					// Once half of what is asked for has arrived, a cut still estimated
					// past it is asked for, so the next read's round trip overlaps
					// this one's last bytes; earlier, the estimate is less sure and
					// the next read would share the link with bytes the cut needs.
					const askedEnd = reads.at(-1)?.end ?? response.end;
					const received = point.offset + filled;
					const needed = Math.min(
						limit,
						Math.max(
							step.need + rate * CUT_FRAMES_SECONDS,
							step.time >= 0 ? aim(step.parsed, step.time) : 0,
						),
					);
					if (
						needed > askedEnd &&
						askedEnd - received <= fetched / 2 &&
						askedEnd < limit &&
						asked < MAX_CUT_READS
					) {
						request(askedEnd, needed);
					}
				}
				if (step?.kind !== "more" || !ended) {
					if (!ended || reads.length > 0) fillBehind(reader);
					return step?.kind === "cut" ? step : null;
				}
				const at = point.offset + filled;
				if (reads.length === 0 && at < limit && asked < MAX_CUT_READS) {
					request(
						at,
						Math.max(
							step.need + margin,
							step.time >= 0 ? aim(step.parsed, step.time) : 0,
						),
					);
				}
			}
			return null;
		} finally {
			cutEnded();
		}
	}

	/// Bytes per second of the cluster at `point`, from where the next entry
	/// point starts, or the file's average.
	private async clusterRate(point: FragmentPoint) {
		const known = this.indexes.get("webm")?.known ?? [];
		const next = known.find((entry) => entry.offset > point.offset);
		if (next && next.time > point.time) {
			return (next.offset - point.offset) / (next.time - point.time);
		}
		return this.bytesPerSecond();
	}

	private index(kind: SeekKind) {
		let index = this.indexes.get(kind);
		if (!index) {
			index = { known: [], locating: new Map(), scanner: null };
			this.indexes.set(kind, index);
		}
		return index;
	}

	/// How to find entry points of `kind` in a window of bytes, plus the ones
	/// the head and tail already show.
	private async scanner(kind: SeekKind): Promise<Scanner | null> {
		const [head, size] = await Promise.all([this.head(), this.fileSize()]);
		if (!head) return null;
		if (kind === "mp4") {
			const seek = await this.seekLayout();
			if (!seek || seek.tailPoints.length === 0) return null;
			const scan: Scanner["scan"] = (window, start) =>
				fragmentsIn(window, start, seek.info);
			return {
				nearBytes: NEAR_SEEK_BYTES,
				scan,
				seeds: [
					...scan(head, 0).points,
					...seek.tailPoints,
					...seek.indexPoints,
				],
			};
		}
		const info = webmSeekInfo(head);
		if (!info) return null;
		const scan: Scanner["scan"] = (window, start) =>
			clustersIn(window, start, info);
		// Video clusters run to megabytes, and a search sizes its aim and its
		// windows by their length, which only two clusters in a row give.
		const enough = info.videoTracks.length > 0 ? 2 : 1;
		let found: FragmentPoint[] = [];
		let cued: FragmentPoint[] = [];
		for (const length of this.tailSteps()) {
			const tail = await this.tail(length);
			if (!tail) break;
			const tailStart = size - tail.byteLength;
			const cues = webmTrailingCues(tail, tailStart, size, info);
			if (cues && !cues.points && tailStart > 0) continue;
			if (cues) this.webmCuesStart = cues.start;
			cued = cues?.points ?? [];
			found = scan(
				cues ? tail.subarray(0, Math.max(0, cues.start - tailStart)) : tail,
				tailStart,
			).points;
			if (found.length >= enough || cued.length > 0 || tailStart === 0) break;
		}
		if (found.length === 0 && cued.length === 0) return null;
		return {
			nearBytes: NEAR_AUDIO_BYTES,
			scan,
			seeds: [...scan(head, 0).points, ...cued, ...found],
		};
	}

	/// Keyframe fragment (MP4) or cluster (WebM) at or before `time` from which
	/// a decoder reaches `time` after a short read, found by interpolating
	/// between entry points already seen and reading small windows. Null when
	/// the file cannot be entered part-way (the caller then reads it from the
	/// start).
	locate(
		time: number,
		signal?: AbortSignal,
		kind: SeekKind = "mp4",
		scrubbing = false,
	) {
		const index = this.index(kind);
		const key = time;
		if (signal?.aborted) return Promise.reject(canceled(signal));
		let entry = index.locating.get(key);
		if (!entry) {
			const controller = new AbortController();
			const created: Locating = {
				result: this.search(kind, time, scrubbing, controller.signal),
				controller,
				waiting: 0,
				keep: false,
				orphanTimer: undefined,
			};
			index.locating.set(key, created);
			const settled = () => {
				clearTimeout(created.orphanTimer);
				if (index.locating.get(key) === created) index.locating.delete(key);
			};
			created.result.then(settled, settled);
			entry = created;
		}
		clearTimeout(entry.orphanTimer);
		entry.orphanTimer = undefined;
		if (!signal) {
			entry.keep = true;
			return entry.result;
		}
		const shared = entry;
		shared.waiting++;
		return new Promise<FragmentPoint | null>((resolve, reject) => {
			const onAbort = () => {
				reject(canceled(signal));
				if (--shared.waiting > 0 || shared.keep) return;
				clearTimeout(shared.orphanTimer);
				shared.orphanTimer = setTimeout(() => {
					if (shared.waiting > 0 || shared.keep) return;
					if (index.locating.get(key) === shared) index.locating.delete(key);
					shared.controller.abort();
				}, ORPHAN_GRACE_MS);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			shared.result.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	}

	private async search(
		kind: SeekKind,
		time: number,
		scrubbing: boolean,
		signal: AbortSignal,
	) {
		const index = this.index(kind);
		index.scanner ??= this.scanner(kind);
		const scanner = await index.scanner.catch(() => null);
		if (!scanner) {
			index.scanner = null;
			return null;
		}
		const size = await this.fileSize();
		remember(index.known, scanner.seeds);
		// A window shorter than a fragment usually lands inside one and finds
		// no entry point; a camera at several megabits a second writes
		// fragments of a megabyte or more.
		const fragmentBytes = typicalFragmentBytes(index.known);
		const nearBytes = Math.max(scanner.nearBytes, fragmentBytes * 2);
		// Aiming a little over one fragment early puts the window on the
		// target's own fragment when the estimate holds. Aiming half the near
		// distance early (a megabyte or more) made the decoder read one or two
		// whole fragments before the target on every far seek. WebM clusters
		// of unknown size have no known length, so audio keeps the wide aim.
		let earlyBytes =
			kind === "mp4" && fragmentBytes > 0
				? Math.min(nearBytes / 2, Math.ceil(fragmentBytes * 1.1))
				: nearBytes / 2;
		const windowBytes = Math.min(
			MAX_PROBE_SCAN,
			Math.max(PROBE_WINDOW, Math.ceil(fragmentBytes * 1.25)),
		);
		for (let probe = 0; probe < MAX_PROBES; probe++) {
			const step = nextFragmentProbe(index.known, time, nearBytes, earlyBytes);
			if ("done" in step) return step.done;
			let at = step.probeAt;
			let grew = false;
			let span = windowBytes;
			while (at < size && at - step.probeAt < MAX_PROBE_SCAN) {
				// A probe aims up to half the near distance before its estimate, so
				// while scrubbing a window that long reaches past the target too,
				// and the next key frames along the drag are already in memory. A
				// lone seek keeps the short window: those extra bytes cost more than
				// they save on a slow link.
				const window = await this.readFully(
					signal,
					at,
					Math.min(size, at + (scrubbing ? Math.max(span, nearBytes) : span)),
				);
				this.recent.unshift({ start: at, bytes: window });
				this.recent.length = Math.min(this.recent.length, RECENT_WINDOWS);
				const { points, resumeAt } = scanner.scan(window, at);
				if (points.length > 0) {
					grew = remember(index.known, points);
					// Past the target: the bitrate varies more than the estimate
					// allowed for, so later probes aim the wide margin early.
					if (points.every((point) => point.time > time)) {
						earlyBytes = nearBytes / 2;
					}
					break;
				}
				// An entry point further apart than the window: keep scanning,
				// with a longer window each time, since a burst of motion writes
				// fragments several times the typical length.
				if (window.byteLength < 16) break;
				at = Math.max(resumeAt, at + 1);
				span = Math.min(MAX_PROBE_SCAN, span * 2);
			}
			if (!grew) break;
		}
		const last = nextFragmentProbe(index.known, time, Number.POSITIVE_INFINITY);
		return "done" in last ? last.done : null;
	}

	/// Where the WebM cluster starting at `offset` ends, when an index or an
	/// earlier read showed it. mediabunny loads a cluster whole before it
	/// returns any of its frames.
	clusterEnd(offset: number) {
		const point = this.indexes
			.get("webm")
			?.known.find((entry) => entry.offset === offset);
		return point && point.end - point.offset > 64 ? point.end : null;
	}

	/// WebM bytes before the first cluster, which a MediaSource needs before
	/// any cluster; null for anything else.
	async webmInit() {
		const head = await this.head();
		const info = head && webmSeekInfo(head);
		return info && head ? head.subarray(0, info.initEnd) : null;
	}

	/// First fragment of the file, where a whole-file decoder starts.
	async firstFragment() {
		const [seek, head] = await Promise.all([this.seekLayout(), this.head()]);
		if (!seek || !head) return null;
		return fragmentsIn(head, 0, seek.info).points[0] ?? null;
	}

	/// How a video decoder can enter this file part-way: at a fragment of a
	/// fragmented MP4, at a key-frame cluster of a WebM written while recording
	/// (no Cues, so a demuxer walks every cluster before a time), or not at all.
	async videoSeekKind(): Promise<SeekKind | null> {
		if (await this.seekLayout().catch(() => null)) return "mp4";
		const head = await this.head().catch(() => null);
		const info = head && webmSeekInfo(head);
		return info?.live && info.videoTracks.length > 0 ? "webm" : null;
	}

	/// Where a whole-file decoder of `kind` starts.
	async firstEntry(kind: SeekKind) {
		if (kind === "mp4") return this.firstFragment();
		const head = await this.head();
		const info = head && webmSeekInfo(head);
		return head && info
			? (clustersIn(head, 0, info).points.find((point) => point.keyframe) ??
					null)
			: null;
	}

	/// Average bytes per second, for judging how far a decoder must walk.
	/// Asked on every decoded frame, so it answers synchronously once known.
	bytesPerSecond(): number | null | Promise<number | null> {
		if (this.rate !== undefined) return this.rate;
		return this.seekLayout()
			.catch(() => null)
			.then((seek) => {
				const last = seek?.tailPoints.at(-1);
				const size = this.sizeValue;
				const duration = last && last.time > 0 ? last.time : this.durationHint;
				this.rate =
					size !== null && duration !== null && duration > 0
						? size / duration
						: null;
				return this.rate;
			});
	}
}

/// The median length of the fragments seen so far, 0 before any. A WebM
/// cluster of unknown size seen without the one after it has no length yet
/// (its end is just past its header) and is left out.
export function typicalFragmentBytes(points: FragmentPoint[]) {
	const lengths = points
		.map((point) => point.end - point.offset)
		.filter((length) => length > 64)
		.sort((a, b) => a - b);
	return lengths[Math.floor(lengths.length / 2)] ?? 0;
}

const entries = new Map<string, RemoteMedia>();

function remoteUrl(url: string) {
	try {
		const parsed = new URL(url, globalThis.location?.href);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}

/// The shared reader for `url`, or null for sources that are not plain HTTP
/// (local blobs), which keep reading through mediabunny directly.
export function remoteMedia(
	url: string,
	size?: number | null,
	duration?: number | null,
	contentType?: string | null,
) {
	if (!remoteUrl(url)) return null;
	let entry = entries.get(url);
	if (!entry) {
		entry = new RemoteMedia(url, size ?? null);
		entries.set(url, entry);
		if (entries.size > MAX_ENTRIES) {
			const oldest = [...entries.values()].sort(
				(a, b) => a.lastUsed - b.lastUsed,
			)[0];
			if (oldest && oldest !== entry) entries.delete(oldest.url);
		}
	}
	if (size) entry.learnSize(size);
	if (duration) entry.learnDuration(duration);
	if (contentType) entry.learnContentType(contentType);
	entry.lastUsed = Date.now();
	return entry;
}

/// Forgets every file's reader and the bytes it holds, for when the editor is
/// torn down.
export function releaseRemoteMedia() {
	entries.clear();
}

/// End of the bytes of `layout` held in memory from `start` on, when they
/// cover [start, end): its own bytes (init, cut cluster headers, trailer) and
/// what `media` holds of the recording, across pieces while they run on.
export function layoutHeldEnd(
	layout: LayoutPiece[],
	media: RemoteMedia,
	start: number,
	end: number,
) {
	let at = start;
	for (const piece of layout) {
		if (piece.end <= at) continue;
		if (piece.start > at) break;
		if (piece.kind === "bytes") {
			at = piece.end;
			continue;
		}
		while (at < piece.end) {
			const source = piece.source + (at - piece.start);
			const held = media.heldEnd(source, source + 1);
			if (held === null || held <= source) break;
			at = Math.min(piece.end, piece.start + (held - piece.source));
		}
		if (at < piece.end) break;
	}
	return at > start && at >= end ? at : null;
}

/// `body` as it is, calling `onFailure` if it errors other than by `signal`.
function watchedBody(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal | undefined,
	onFailure: () => void,
) {
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (cause) {
				if (!signal?.aborted) onFailure();
				controller.error(cause);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

/// `fetch` for a mediabunny `UrlSource` reading `layout`. mediabunny asks for
/// open-ended ranges and aborts once it has what it wanted, which closes the
/// connection; bounded reads finish instead, so the next request reuses the
/// connection. Each read stops where the reader asking for it wants to stop
/// (`wantedEnd`), or, when that is unknown, at a chunk that grows while reads
/// stay sequential. `onFailure` hears of a read that failed other than by
/// being canceled.
export function layoutFetch(
	media: RemoteMedia,
	layout: LayoutPiece[],
	wantedEnd?: (start: number) => number | null,
	onFailure?: () => void,
) {
	const size = layoutSize(layout);
	// A decoder entering at a located fragment reads on from it to its
	// target, often most of a fragment, so its reads keep the growing chunk
	// rather than stopping at each read-ahead target one round trip apart.
	const region = layout[0]?.kind === "bytes";
	let sequentialEnd = -1;
	let chunk = FIRST_CHUNK;
	return async (_input: RequestInfo | URL, init?: RequestInit) => {
		const range = /^bytes=(\d+)-(\d*)$/.exec(
			new Headers(init?.headers).get("Range") ?? "",
		);
		const start = range ? Number(range[1]) : 0;
		const signal = init?.signal ?? undefined;
		if (start >= size) {
			return new Response(null, {
				status: 416,
				headers: { "Content-Range": `bytes */${size}` },
			});
		}
		chunk =
			start === sequentialEnd ? Math.min(chunk * 2, MAX_CHUNK) : FIRST_CHUNK;
		const requestedEnd = range?.[2] ? Number(range[2]) + 1 : size;
		const wanted = wantedEnd?.(start) ?? null;
		const length =
			wanted !== null && wanted > start
				? Math.min(
						region ? Math.max(wanted - start, chunk) : wanted - start,
						MAX_CHUNK,
					)
				: chunk;
		const burst = layout.find(
			(piece) =>
				piece.kind === "remote" &&
				piece.start === start &&
				piece.burstEnd !== undefined,
		);
		const whole =
			burst?.kind === "remote" && burst.burstEnd !== undefined
				? Math.min(MAX_CHUNK, burst.burstEnd - burst.source)
				: 0;
		const plan = planLayoutRead(
			layout,
			start,
			Math.min(Math.max(length, whole), requestedEnd - start),
		);
		if (!plan) {
			return new Response(null, {
				status: 416,
				headers: { "Content-Range": `bytes */${size}` },
			});
		}
		let body: ReadableStream<Uint8Array>;
		let end: number;
		if (plan.kind === "bytes") {
			body = bytesStream(plan.bytes);
			end = plan.end;
			sequentialEnd = -1;
		} else {
			let response: RangeResponse;
			try {
				const piece = layout.find(
					(entry) => entry.start <= start && start < entry.end,
				);
				if (piece?.kind === "remote" && piece.deferred) {
					await afterClusterCuts(signal);
				}
				response = await media.read(plan.sourceStart, plan.sourceEnd, signal);
			} catch (cause) {
				if (signal?.aborted) throw cause;
				onFailure?.();
				// mediabunny fails a read on an error status instead of retrying,
				// so the decoder falls back rather than waiting forever.
				return new Response(null, {
					status: cause instanceof MediaStorageError ? cause.status : 502,
				});
			}
			body = onFailure
				? watchedBody(response.body, signal, onFailure)
				: response.body;
			end = plan.start + (response.end - plan.sourceStart);
			sequentialEnd = end;
		}
		return new Response(body, {
			status: 206,
			headers: {
				"Content-Range": `bytes ${start}-${end - 1}/${size}`,
				"Content-Length": String(end - start),
			},
		});
	};
}

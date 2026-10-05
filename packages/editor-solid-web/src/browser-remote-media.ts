import { startMediaRead } from "./browser-network-budget";
import {
	emptyMfra,
	endsWithMfro,
	type FragmentPoint,
	fragmentsIn,
	type LayoutPiece,
	layoutSize,
	type Mp4SeekInfo,
	mp4SeekInfo,
	nextFragmentProbe,
	planLayoutRead,
	virtualLayout,
} from "./fragmented-mp4-seek";
import { clustersIn, webmSeekInfo } from "./webm-cluster-seek";

/// mediabunny's first read of a file covers half a megabyte, which holds the
/// `moov` and the first fragments of a recording.
const HEAD_BYTES = 512 * 1024;
/// WebM audio keeps its headers in the first few hundred bytes and usually
/// writes a cluster about every second, so this much of its start or end holds
/// what the probe, the audio stream and a seek need. A seek reads more of the
/// end when the last cluster starts further back.
const AUDIO_WEBM_BYTES = 64 * 1024;
const MIN_TAIL = 256 * 1024;
const MAX_FIRST_TAIL = 4 * 1024 * 1024;
const TAIL_STEPS = [2 * 1024 * 1024, 8 * 1024 * 1024];

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
/// Probe windows kept so the decoder that starts at a found fragment reads
/// its first bytes from memory.
const RECENT_WINDOWS = 8;

/// Bytes for the first read of a file's tail: enough for its last fragment
/// (a second or two of media) when the average bitrate is known, since a read
/// too short to hold it costs another round trip.
export function firstTailBytes(size: number | null, duration: number | null) {
	if (size === null || duration === null || !(duration > 0)) return MIN_TAIL;
	const fourSeconds = (size / duration) * 4;
	const rounded = Math.ceil(fourSeconds / 65536) * 65536;
	return Math.max(MIN_TAIL, Math.min(MAX_FIRST_TAIL, rounded));
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

type Pinned = { start: number; end: number; bytes: Promise<Uint8Array | null> };

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
	locating: Map<number, Promise<FragmentPoint | null>>;
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
	private readonly recent: { start: number; bytes: Uint8Array }[] = [];
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
	} | null> | null = null;
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

	get size() {
		return this.sizeValue;
	}

	learnSize(size: number) {
		if (this.sizeValue === null) this.sizeValue = size;
	}

	/// Starts reading the head and tail.
	warm() {
		void this.head().catch(() => undefined);
		void this.fileSize()
			.then(() => this.tail(this.pinnedTailBytes()))
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

	private pin(start: number, end: number) {
		const existing = this.pinned.find(
			(block) => block.start === start && block.end === end,
		);
		if (existing) return existing.bytes;
		const block: Pinned = {
			start,
			end,
			bytes: this.network(start, end).then(async (response) => {
				const bytes = await readAll(response.body, response.end - start);
				return bytes.byteLength === response.end - start ? bytes : null;
			}),
		};
		this.pinned.push(block);
		block.bytes.then(
			(bytes) => {
				if (!bytes) this.unpin(block);
			},
			() => this.unpin(block),
		);
		return block.bytes;
	}

	private unpin(block: Pinned) {
		const index = this.pinned.indexOf(block);
		if (index >= 0) this.pinned.splice(index, 1);
	}

	head() {
		if (!this.headPromise) {
			const bytes = this.audioWebm ? AUDIO_WEBM_BYTES : HEAD_BYTES;
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
	/// The first tail read stays pinned; longer ones are one-off reads.
	tail(length: number): Promise<Uint8Array | null> {
		const pinned = this.pinnedTail;
		if (pinned && pinned.length >= length) return pinned.bytes;
		if (pinned) {
			return this.fileSize().then((size) => {
				const start = Math.max(0, size - length);
				return this.network(start, size).then((response) =>
					readAll(response.body, size - start),
				);
			});
		}
		const wanted = Math.max(length, this.pinnedTailBytes());
		const entry = {
			length: wanted,
			bytes: this.fileSize().then((size) =>
				this.pin(Math.max(0, size - wanted), size),
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
	private async readFully(start: number, end: number) {
		const out = new Uint8Array(end - start);
		let filled = 0;
		while (start + filled < end) {
			const response = await this.read(start + filled, end);
			const bytes = await readAll(response.body, response.end - start - filled);
			if (bytes.byteLength === 0) break;
			out.set(bytes, filled);
			filled += bytes.byteLength;
		}
		return out.subarray(0, filled);
	}

	/// What seeking needs: the video track's timing and whether the file can
	/// take an empty `mfra` trailer (fragmented, ends in a whole fragment, no
	/// index of its own). Null for anything else, which reads as before.
	seekLayout() {
		if (!this.seekPromise) {
			this.seekPromise = (async () => {
				const [head, size] = await Promise.all([this.head(), this.fileSize()]);
				if (!head) throw new MediaStorageError(502);
				const info = mp4SeekInfo(head);
				if (!info) return null;
				for (const length of [this.pinnedTailBytes(), ...TAIL_STEPS]) {
					const tail = await this.tail(length);
					if (!tail || endsWithMfro(tail)) return null;
					const tailStart = size - tail.byteLength;
					const { points } = fragmentsIn(tail, tailStart, info);
					if (points.at(-1)?.end === size) {
						return { info, trailer: emptyMfra(), tailPoints: points };
					}
					if (tailStart === 0) return null;
				}
				return { info, trailer: null, tailPoints: [] };
			})();
			this.seekPromise.catch(() => {
				this.seekPromise = null;
			});
		}
		return this.seekPromise;
	}

	/// Virtual file for a decoder: the whole recording, or (with `from`) the
	/// init bytes followed by the recording from the fragment at `from`.
	async layout(from: number | null): Promise<LayoutPiece[]> {
		const size = await this.fileSize();
		const seek = await this.seekLayout().catch(() => null);
		if (!seek || from === null) {
			return virtualLayout(null, 0, size, seek?.trailer ?? null);
		}
		const head = await this.head();
		if (!head) throw new Error("Editor media head is unavailable");
		return virtualLayout(
			head.subarray(0, seek.info.moovEnd),
			from,
			size,
			seek.trailer,
		);
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
				seeds: [...scan(head, 0).points, ...seek.tailPoints],
			};
		}
		const info = webmSeekInfo(head);
		if (!info) return null;
		const scan: Scanner["scan"] = (window, start) =>
			clustersIn(window, start, info);
		for (const length of [this.pinnedTailBytes(), MIN_TAIL, ...TAIL_STEPS]) {
			const tail = await this.tail(length);
			if (!tail) return null;
			const tailStart = size - tail.byteLength;
			const tailPoints = scan(tail, tailStart).points;
			if (tailPoints.length > 0) {
				return {
					nearBytes: NEAR_AUDIO_BYTES,
					scan,
					seeds: [...scan(head, 0).points, ...tailPoints],
				};
			}
			if (tailStart === 0) return null;
		}
		return null;
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
		let pending = index.locating.get(key);
		if (!pending) {
			pending = this.search(kind, time, scrubbing);
			index.locating.set(key, pending);
			const settled = () => {
				if (index.locating.get(key) === pending) index.locating.delete(key);
			};
			pending.then(settled, settled);
		}
		if (!signal) return pending;
		if (signal.aborted) return Promise.reject(canceled(signal));
		const shared = pending;
		return new Promise<FragmentPoint | null>((resolve, reject) => {
			const onAbort = () => reject(canceled(signal));
			signal.addEventListener("abort", onAbort, { once: true });
			shared.then(
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

	private async search(kind: SeekKind, time: number, scrubbing: boolean) {
		const index = this.index(kind);
		index.scanner ??= this.scanner(kind);
		const scanner = await index.scanner.catch(() => null);
		if (!scanner) {
			index.scanner = null;
			return null;
		}
		const size = await this.fileSize();
		remember(index.known, scanner.seeds);
		for (let probe = 0; probe < MAX_PROBES; probe++) {
			const step = nextFragmentProbe(index.known, time, scanner.nearBytes);
			if ("done" in step) return step.done;
			let at = step.probeAt;
			let grew = false;
			while (at < size && at - step.probeAt < MAX_PROBE_SCAN) {
				// A probe aims up to half the near distance before its estimate, so
				// while scrubbing a window that long reaches past the target too,
				// and the next key frames along the drag are already in memory. A
				// lone seek keeps the short window: those extra bytes cost more than
				// they save on a slow link.
				const window = await this.readFully(
					at,
					Math.min(
						size,
						at +
							(scrubbing
								? Math.max(PROBE_WINDOW, scanner.nearBytes)
								: PROBE_WINDOW),
					),
				);
				this.recent.unshift({ start: at, bytes: window });
				this.recent.length = Math.min(this.recent.length, RECENT_WINDOWS);
				const { points, resumeAt } = scanner.scan(window, at);
				if (points.length > 0) {
					grew = remember(index.known, points);
					break;
				}
				// An entry point further apart than the window: keep scanning.
				if (window.byteLength < 16) break;
				at = Math.max(resumeAt, at + 1);
			}
			if (!grew) break;
		}
		const last = nextFragmentProbe(index.known, time, Number.POSITIVE_INFINITY);
		return "done" in last ? last.done : null;
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

	/// Average bytes per second, for judging how far a decoder must walk.
	/// Asked on every decoded frame, so it answers synchronously once known.
	bytesPerSecond(): number | null | Promise<number | null> {
		if (this.rate !== undefined) return this.rate;
		return this.seekLayout()
			.catch(() => null)
			.then((seek) => {
				const last = seek?.tailPoints.at(-1);
				const size = this.sizeValue;
				this.rate =
					last && size !== null && last.time > 0 ? size / last.time : null;
				return this.rate;
			});
	}
}

const entries = new Map<string, RemoteMedia>();

function remoteUrl(url: string) {
	try {
		const parsed = new URL(url, window.location.href);
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

/// `fetch` for a mediabunny `UrlSource` reading `layout`. mediabunny asks for
/// open-ended ranges and aborts once it has what it wanted, which closes the
/// connection; bounded chunks that grow while reads stay sequential finish
/// instead, so the next request reuses the connection.
export function layoutFetch(media: RemoteMedia, layout: LayoutPiece[]) {
	const size = layoutSize(layout);
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
		const plan = planLayoutRead(
			layout,
			start,
			Math.min(chunk, requestedEnd - start),
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
				response = await media.read(plan.sourceStart, plan.sourceEnd, signal);
			} catch (cause) {
				if (signal?.aborted) throw cause;
				// mediabunny fails a read on an error status instead of retrying,
				// so the decoder falls back rather than waiting forever.
				return new Response(null, {
					status: cause instanceof MediaStorageError ? cause.status : 502,
				});
			}
			body = response.body;
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

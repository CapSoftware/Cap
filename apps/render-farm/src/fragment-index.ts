import {
	box,
	build,
	MAX_SAMPLES,
	type Run,
	sampleTable,
	type TrackIndex,
} from "./mp4";
import { MAX_REMUX_KEYFRAME_GAP_SECONDS } from "./transcode";

// Browser recordings are fragmented MP4: a moov with no samples, then
// moof + mdat pairs. The planner needs a sample index to fetch only the bytes
// each chunk decodes, and those files spread it over thousands of moofs, so
// they used to be remuxed first (download, rewrite, upload, read back). Here
// the moofs are read in place and turned into a regular moov for the same
// samples, laid out as a prefix:
//
//   ftyp | free (provenance) | moov | mdat header | the source, untouched
//
// The source's sample offsets shift by the prefix size. Workers write the
// prefix, then the source ranges they need, and ffmpeg opens the result like
// the remuxed file, so the renderer needs no changes.

export class UnsupportedSource extends Error {}

export const PREFIX_VERSION = 1;

type Box = { type: string; start: number; body: number; end: number };

function boxAt(view: DataView, offset: number, limit: number): Box | null {
	if (offset + 8 > limit) return null;
	let size = view.getUint32(offset);
	let body = offset + 8;
	if (size === 1) {
		if (offset + 16 > limit) return null;
		size = Number(view.getBigUint64(offset + 8));
		body = offset + 16;
	} else if (size === 0) {
		size = limit - offset;
	}
	const type = String.fromCharCode(
		view.getUint8(offset + 4),
		view.getUint8(offset + 5),
		view.getUint8(offset + 6),
		view.getUint8(offset + 7),
	);
	if (size < body - offset) throw new UnsupportedSource(`bad ${type} box`);
	return { type, start: offset, body, end: offset + size };
}

function childrenOf(view: DataView, parent: { body: number; end: number }) {
	const out: Box[] = [];
	let offset = parent.body;
	while (offset + 8 <= parent.end) {
		const child = boxAt(view, offset, parent.end);
		if (!child || child.end > parent.end) {
			throw new UnsupportedSource("box overruns its parent");
		}
		out.push(child);
		offset = child.end;
	}
	return out;
}

function only(boxes: Box[], type: string) {
	return boxes.find((candidate) => candidate.type === type);
}

function need(boxes: Box[], type: string) {
	const found = only(boxes, type);
	if (!found) throw new UnsupportedSource(`no ${type}`);
	return found;
}

type TrackDefaults = {
	descriptionIndex: number;
	duration: number;
	size: number;
	flags: number;
};

export type FragmentedInit = {
	/** Offset just past the moov: the first fragment starts at or after it. */
	moovEnd: number;
	trackId: number;
	timescale: number;
	/** Sample description fourcc, e.g. avc1. */
	codec: string;
	/** The avcC record, when the codec is H.264. */
	avcC: Uint8Array | null;
	defaults: Map<number, TrackDefaults>;
	/** Boxes the built moov reuses as they are (durations patched). */
	reuse: {
		mvhd: Uint8Array;
		tkhd: Uint8Array;
		mdhd: Uint8Array;
		hdlr: Uint8Array;
		mediaHeader: Uint8Array;
		dinf: Uint8Array;
		stsd: Uint8Array;
	};
};

/**
 * The first video track of a fragmented file's moov (`moov` = the whole box,
 * found at `moovStart`), or null when the file isn't fragmented.
 */
export function parseFragmentedInit(
	moov: Uint8Array,
	moovStart: number,
): FragmentedInit | null {
	const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
	const root = boxAt(view, 0, moov.byteLength);
	if (!root || root.type !== "moov") throw new UnsupportedSource("no moov");
	const top = childrenOf(view, root);
	const mvex = only(top, "mvex");
	if (!mvex) return null;
	const defaults = new Map<number, TrackDefaults>();
	for (const trex of childrenOf(view, mvex)) {
		if (trex.type !== "trex" || trex.end - trex.body < 24) continue;
		defaults.set(view.getUint32(trex.body + 4), {
			descriptionIndex: view.getUint32(trex.body + 8),
			duration: view.getUint32(trex.body + 12),
			size: view.getUint32(trex.body + 16),
			flags: view.getUint32(trex.body + 20),
		});
	}
	const slice = (found: Box) => moov.slice(found.start, found.end);
	for (const trak of top.filter((candidate) => candidate.type === "trak")) {
		const trakChildren = childrenOf(view, trak);
		const mdia = need(trakChildren, "mdia");
		const mdiaChildren = childrenOf(view, mdia);
		const hdlr = need(mdiaChildren, "hdlr");
		if (hdlr.body + 12 > hdlr.end) continue;
		const handler = String.fromCharCode(
			...moov.subarray(hdlr.body + 8, hdlr.body + 12),
		);
		if (handler !== "vide") continue;
		// The first video track is the one ffmpeg's `-map 0:v:0` remux took.
		if (only(trakChildren, "edts")) {
			throw new UnsupportedSource("the video track has an edit list");
		}
		const tkhd = need(trakChildren, "tkhd");
		const tkhdVersion = view.getUint8(tkhd.body);
		const trackId = view.getUint32(tkhd.body + (tkhdVersion === 1 ? 20 : 12));
		const mdhd = need(mdiaChildren, "mdhd");
		const timescale = view.getUint32(
			mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12),
		);
		if (!timescale) throw new UnsupportedSource("zero timescale");
		const minf = need(mdiaChildren, "minf");
		const minfChildren = childrenOf(view, minf);
		const stbl = need(minfChildren, "stbl");
		const stblChildren = childrenOf(view, stbl);
		const stsd = need(stblChildren, "stsd");
		const stsz = only(stblChildren, "stsz");
		if (stsz && view.getUint32(stsz.body + 8) !== 0) {
			throw new UnsupportedSource("samples in the moov as well as fragments");
		}
		const entries = childrenOf(view, {
			body: stsd.body + 8,
			end: stsd.end,
		});
		const entry = entries[0];
		if (!entry || view.getUint32(stsd.body + 4) !== 1) {
			throw new UnsupportedSource("not exactly one sample description");
		}
		const codec = entry.type;
		// VisualSampleEntry: 78 bytes of fields before its child boxes.
		const avcC =
			codec === "avc1" || codec === "avc3"
				? childrenOf(view, { body: entry.body + 78, end: entry.end }).find(
						(candidate) => candidate.type === "avcC",
					)
				: undefined;
		const mediaHeader = only(minfChildren, "vmhd");
		const dinf = only(minfChildren, "dinf");
		const mvhd = need(top, "mvhd");
		if (!mediaHeader || !dinf) throw new UnsupportedSource("no vmhd/dinf");
		if (!defaults.has(trackId)) throw new UnsupportedSource("no trex");
		return {
			moovEnd: moovStart + root.end,
			trackId,
			timescale,
			codec,
			avcC: avcC ? moov.slice(avcC.body, avcC.end) : null,
			defaults,
			reuse: {
				mvhd: slice(mvhd),
				tkhd: slice(tkhd),
				mdhd: slice(mdhd),
				hdlr: slice(hdlr),
				mediaHeader: slice(mediaHeader),
				dinf: slice(dinf),
				stsd: slice(stsd),
			},
		};
	}
	throw new UnsupportedSource("no video track");
}

/** Video samples of a fragmented file, in decode order. */
export class FragmentSamples {
	dts: number[] = [];
	/** Composition offsets: presentation time = decode time + offset. */
	offsets: number[] = [];
	sizes: number[] = [];
	positions: number[] = [];
	sync: boolean[] = [];
	lastDuration = 0;
	/** Decode time the next fragment starts at when it carries no tfdt. */
	nextDts = 0;
	firstDts: number | null = null;

	get count() {
		return this.dts.length;
	}
}

const TFHD_BASE_OFFSET = 0x1;
const TFHD_DESCRIPTION = 0x2;
const TFHD_DURATION = 0x8;
const TFHD_SIZE = 0x10;
const TFHD_FLAGS = 0x20;
const TFHD_EMPTY = 0x10000;
const TFHD_BASE_IS_MOOF = 0x20000;
const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_FLAGS = 0x4;
const TRUN_DURATION = 0x100;
const TRUN_SIZE = 0x200;
const TRUN_FLAGS = 0x400;
const TRUN_COMPOSITION = 0x800;
// ffmpeg counts a sample as a keyframe when neither is set.
const SAMPLE_NON_SYNC = 0x10000;
const SAMPLE_DEPENDS_YES = 0x1000000;

/**
 * Appends the video track's samples from one moof (`moof` = the whole box,
 * which starts at `position` in the file). Other tracks' runs are walked
 * only to find where the next traf's data starts.
 */
export function readMoof(
	moof: Uint8Array,
	position: number,
	init: FragmentedInit,
	samples: FragmentSamples,
) {
	const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
	const root = boxAt(view, 0, moof.byteLength);
	if (!root || root.type !== "moof") throw new UnsupportedSource("not a moof");
	let previousEnd = position;
	for (const traf of childrenOf(view, root)) {
		if (traf.type !== "traf") continue;
		const trafChildren = childrenOf(view, traf);
		const tfhd = need(trafChildren, "tfhd");
		const tfhdFlags = view.getUint32(tfhd.body) & 0xffffff;
		const trackId = view.getUint32(tfhd.body + 4);
		const trex = init.defaults.get(trackId);
		if (!trex)
			throw new UnsupportedSource(`fragment for unknown track ${trackId}`);
		let at = tfhd.body + 8;
		let base = previousEnd;
		if (tfhdFlags & TFHD_BASE_OFFSET) {
			base = Number(view.getBigUint64(at));
			at += 8;
		} else if (tfhdFlags & TFHD_BASE_IS_MOOF) {
			base = position;
		}
		let descriptionIndex = trex.descriptionIndex;
		if (tfhdFlags & TFHD_DESCRIPTION) {
			descriptionIndex = view.getUint32(at);
			at += 4;
		}
		let defaultDuration = trex.duration;
		if (tfhdFlags & TFHD_DURATION) {
			defaultDuration = view.getUint32(at);
			at += 4;
		}
		let defaultSize = trex.size;
		if (tfhdFlags & TFHD_SIZE) {
			defaultSize = view.getUint32(at);
			at += 4;
		}
		let defaultFlags = trex.flags;
		if (tfhdFlags & TFHD_FLAGS) defaultFlags = view.getUint32(at);
		const video = trackId === init.trackId;
		if (video && descriptionIndex !== 1) {
			throw new UnsupportedSource("a fragment uses another sample description");
		}
		const tfdt = only(trafChildren, "tfdt");
		let dts = samples.nextDts;
		if (video && tfdt) {
			dts =
				view.getUint8(tfdt.body) === 1
					? Number(view.getBigUint64(tfdt.body + 4))
					: view.getUint32(tfdt.body + 4);
		}
		let dataAt = base;
		if (tfhdFlags & TFHD_EMPTY) {
			previousEnd = base;
			continue;
		}
		for (const trun of trafChildren) {
			if (trun.type !== "trun") continue;
			const version = view.getUint8(trun.body);
			const flags = view.getUint32(trun.body) & 0xffffff;
			const count = view.getUint32(trun.body + 4);
			let cursor = trun.body + 8;
			if (flags & TRUN_DATA_OFFSET) {
				dataAt = base + view.getInt32(cursor);
				cursor += 4;
			}
			let firstFlags: number | null = null;
			if (flags & TRUN_FIRST_FLAGS) {
				firstFlags = view.getUint32(cursor);
				cursor += 4;
			}
			const entrySize =
				4 *
				[TRUN_DURATION, TRUN_SIZE, TRUN_FLAGS, TRUN_COMPOSITION].filter(
					(bit) => flags & bit,
				).length;
			if (cursor + count * entrySize > trun.end) {
				throw new UnsupportedSource("trun lists more samples than it holds");
			}
			if (video && samples.count + count > MAX_SAMPLES) {
				throw new UnsupportedSource(`more than ${MAX_SAMPLES} video samples`);
			}
			for (let index = 0; index < count; index++) {
				let duration = defaultDuration;
				let size = defaultSize;
				let sampleFlags =
					index === 0 && firstFlags !== null ? firstFlags : defaultFlags;
				let composition = 0;
				if (flags & TRUN_DURATION) {
					duration = view.getUint32(cursor);
					cursor += 4;
				}
				if (flags & TRUN_SIZE) {
					size = view.getUint32(cursor);
					cursor += 4;
				}
				if (flags & TRUN_FLAGS) {
					sampleFlags = view.getUint32(cursor);
					cursor += 4;
				}
				if (flags & TRUN_COMPOSITION) {
					composition =
						version === 0 ? view.getUint32(cursor) : view.getInt32(cursor);
					cursor += 4;
				}
				if (video) {
					samples.firstDts ??= dts;
					samples.dts.push(dts);
					samples.offsets.push(composition);
					samples.sizes.push(size);
					samples.positions.push(dataAt);
					samples.sync.push(
						(sampleFlags & (SAMPLE_NON_SYNC | SAMPLE_DEPENDS_YES)) === 0,
					);
					samples.lastDuration = duration;
					dts += duration;
				}
				dataAt += size;
			}
		}
		if (video) samples.nextDts = dts;
		previousEnd = dataAt;
	}
}

export type RangeReader = (
	start: number,
	endInclusive: number,
) => Promise<Uint8Array>;

/** Moof offsets for `trackId` from an `mfra` in the file's last bytes. */
export function mfraMoofs(tail: Uint8Array, trackId: number) {
	const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	if (tail.byteLength < 16) return null;
	const mfro = tail.byteLength - 16;
	if (
		view.getUint32(mfro) !== 16 ||
		String.fromCharCode(...tail.subarray(mfro + 4, mfro + 8)) !== "mfro"
	) {
		return null;
	}
	const size = view.getUint32(mfro + 12);
	const start = tail.byteLength - size;
	if (size < 24 || start < 0) return { size };
	const mfra = boxAt(view, start, tail.byteLength);
	if (!mfra || mfra.type !== "mfra") return null;
	const moofs = new Set<number>();
	for (const tfra of childrenOf(view, mfra)) {
		if (tfra.type !== "tfra" || view.getUint32(tfra.body + 4) !== trackId) {
			continue;
		}
		const version = view.getUint8(tfra.body);
		const lengths = view.getUint32(tfra.body + 8);
		const skip =
			((lengths >> 4) & 3) +
			1 +
			(((lengths >> 2) & 3) + 1) +
			((lengths & 3) + 1);
		const entries = view.getUint32(tfra.body + 12);
		const entrySize = (version === 1 ? 16 : 8) + skip;
		let cursor = tfra.body + 16;
		if (cursor + entries * entrySize > tfra.end) {
			throw new UnsupportedSource("tfra lists more entries than it holds");
		}
		for (let index = 0; index < entries; index++) {
			moofs.add(
				version === 1
					? Number(view.getBigUint64(cursor + 8))
					: view.getUint32(cursor + 4),
			);
			cursor += entrySize;
		}
	}
	return { size, moofs: [...moofs].sort((a, b) => a - b) };
}

type Region = { start: number; end: number; bytes: Promise<Uint8Array> };

/**
 * Reads served from ranges fetched ahead: either small reads at the moofs an
 * mfra lists, or (with no mfra) the whole file in large pieces, a window at a
 * time, dropping what the walk has passed.
 */
class Prefetch {
	private regions: Region[] = [];
	private window: Map<number, Promise<Uint8Array>> | null = null;
	requests = 0;
	bytes = 0;

	constructor(
		private read: RangeReader,
		private size: number,
		private options: {
			concurrency: number;
			piece: number;
			windowPieces: number;
		},
	) {}

	private active = 0;
	private waiting: (() => void)[] = [];

	private async fetch(start: number, end: number) {
		if (this.active >= this.options.concurrency) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		} else {
			this.active++;
		}
		try {
			const bytes = await this.read(start, end - 1);
			if (bytes.byteLength !== end - start) {
				throw new Error(`short read ${start}-${end}: ${bytes.byteLength}`);
			}
			this.requests++;
			this.bytes += bytes.byteLength;
			return bytes;
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.active--;
		}
	}

	/** Fetch these [start, end) ranges now, for reads that fall inside them. */
	hint(ranges: [number, number][]) {
		for (const [start, end] of ranges) {
			const clamped = Math.min(end, this.size);
			if (clamped <= start) continue;
			const bytes = this.fetch(start, clamped);
			bytes.catch(() => {});
			this.regions.push({ start, end: clamped, bytes });
		}
		this.regions.sort((a, b) => a.start - b.start);
	}

	stream() {
		this.window = new Map();
	}

	private piece(index: number) {
		const window = this.window as Map<number, Promise<Uint8Array>>;
		let bytes = window.get(index);
		if (!bytes) {
			const start = index * this.options.piece;
			bytes = this.fetch(
				start,
				Math.min(this.size, start + this.options.piece),
			);
			bytes.catch(() => {});
			window.set(index, bytes);
		}
		return bytes;
	}

	async get(start: number, end: number): Promise<Uint8Array> {
		end = Math.min(end, this.size);
		if (this.window) {
			const piece = this.options.piece;
			const first = Math.floor(start / piece);
			const last = Math.floor((end - 1) / piece);
			for (const index of this.window.keys()) {
				if (index < first) this.window.delete(index);
			}
			const pieces = Math.ceil(this.size / piece);
			for (
				let index = first;
				index < Math.min(pieces, last + 1 + this.options.windowPieces);
				index++
			) {
				this.piece(index);
			}
			const out = new Uint8Array(end - start);
			for (let index = first; index <= last; index++) {
				const bytes = await this.piece(index);
				const pieceStart = index * piece;
				const from = Math.max(start, pieceStart);
				const to = Math.min(end, pieceStart + bytes.byteLength);
				out.set(
					bytes.subarray(from - pieceStart, to - pieceStart),
					from - start,
				);
			}
			return out;
		}
		// Regions are sorted and don't overlap: the last one starting at or
		// before `start` is the only one that can cover the read.
		let low = 0;
		let high = this.regions.length - 1;
		while (low <= high) {
			const middle = (low + high) >> 1;
			if ((this.regions[middle] as Region).start <= start) low = middle + 1;
			else high = middle - 1;
		}
		const region = this.regions[high];
		if (region && region.end >= end) {
			const bytes = await region.bytes;
			return bytes.subarray(start - region.start, end - region.start);
		}
		return this.fetch(start, end);
	}
}

/** Bytes read per moof listed in an mfra: the moof and the next box header. */
const MOOF_READ = 4096;

export type FragmentScan = {
	samples: FragmentSamples;
	fragments: number;
	usedMfra: boolean;
	requests: number;
	bytes: number;
};

/**
 * Walks every top-level box after the moov and reads each moof. An mfra, when
 * the recorder wrote one, says where the moofs are, so they're fetched in
 * parallel small reads; otherwise the file streams through in large pieces.
 */
export async function scanFragments(
	read: RangeReader,
	size: number,
	init: FragmentedInit,
	options: {
		concurrency?: number;
		piece?: number;
		windowPieces?: number;
		tailBytes?: number;
	} = {},
): Promise<FragmentScan> {
	// 128 small reads in flight index a 2 h recording's 3,600 moofs in under
	// a second from the coordinator; 32 took 9 s, 64 about 1.5 s.
	const prefetch = new Prefetch(read, size, {
		concurrency: options.concurrency ?? 128,
		piece: options.piece ?? 8 << 20,
		windowPieces: options.windowPieces ?? 12,
	});
	const tailStart = Math.max(
		init.moovEnd,
		size - (options.tailBytes ?? 256 << 10),
	);
	if (size - tailStart >= 16) prefetch.hint([[tailStart, size]]);
	let found =
		size - tailStart >= 16
			? mfraMoofs(await prefetch.get(tailStart, size), init.trackId)
			: null;
	if (found && !found.moofs && size - found.size >= init.moovEnd) {
		found = mfraMoofs(
			await prefetch.get(size - found.size, size),
			init.trackId,
		);
	}
	const moofs = (found?.moofs ?? []).filter(
		(offset) => offset >= init.moovEnd && offset < size,
	);
	const usedMfra = moofs.length > 0;
	if (usedMfra) {
		// From a little before each moof (a styp may lead it) to past the
		// mdat header after it; regions stay clear of the tail's.
		const ranges: [number, number][] = [];
		for (const offset of moofs) {
			const last = ranges[ranges.length - 1];
			const start = Math.max(init.moovEnd, offset - 256, last?.[1] ?? 0);
			const end = Math.min(tailStart, offset + MOOF_READ);
			if (end <= start) continue;
			if (last && start <= last[1] + MOOF_READ) last[1] = end;
			else ranges.push([start, end]);
		}
		prefetch.hint(ranges);
	} else {
		prefetch.stream();
	}
	const samples = new FragmentSamples();
	let fragments = 0;
	let offset = init.moovEnd;
	while (offset + 8 <= size) {
		const header = await prefetch.get(offset, Math.min(size, offset + 16));
		const found = boxAt(
			new DataView(header.buffer, header.byteOffset, header.byteLength),
			0,
			header.byteLength,
		);
		if (!found) break;
		let length = found.end;
		if (view32(header, 0) === 0) length = size - offset;
		if (found.type === "moof") {
			if (offset + length > size) throw new UnsupportedSource("truncated moof");
			readMoof(
				await prefetch.get(offset, offset + length),
				offset,
				init,
				samples,
			);
			fragments++;
		} else if (found.type === "mfra") {
			break;
		}
		if (length < 8) throw new UnsupportedSource("zero-length box");
		offset += length;
	}
	return {
		samples,
		fragments,
		usedMfra,
		requests: prefetch.requests,
		bytes: prefetch.bytes,
	};
}

function view32(bytes: Uint8Array, at: number) {
	return new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getUint32(at);
}

function patchDuration(
	boxBytes: Uint8Array,
	at: { v0: number; v1: number },
	value: number,
) {
	const out = boxBytes.slice();
	const view = new DataView(out.buffer);
	// Full boxes: version at byte 8, after the 8-byte header.
	if (view.getUint8(8) === 1) {
		view.setBigUint64(at.v1, BigInt(value));
	} else {
		if (value > 0xffffffff) throw new UnsupportedSource("duration overflows");
		view.setUint32(at.v0, value);
	}
	return out;
}

export type Provenance = {
	version: number;
	source: string;
	size: number;
};

/**
 * The prefix for a fragmented source (see the top of this file) and the index
 * the planner uses, with sample offsets counted in the prefixed file.
 */
export function buildPrefix(
	init: FragmentedInit,
	samples: FragmentSamples,
	provenance: Provenance,
) {
	const count = samples.count;
	if (count === 0) throw new UnsupportedSource("no video samples");
	if (samples.firstDts !== 0) {
		// A remux keeps that start with an edit list; not worth matching.
		throw new UnsupportedSource("video doesn't start at time 0");
	}
	const stts: [number, number][] = [];
	for (let index = 0; index < count; index++) {
		const delta =
			index + 1 < count
				? (samples.dts[index + 1] as number) - (samples.dts[index] as number)
				: samples.lastDuration;
		if (delta < 0) throw new UnsupportedSource("decode times go backwards");
		const last = stts[stts.length - 1];
		if (last && last[1] === delta) last[0]++;
		else stts.push([1, delta]);
	}
	const mediaDuration =
		(samples.dts[count - 1] as number) + samples.lastDuration;
	let ctts: [number, number][] | null = null;
	if (samples.offsets.some((offset) => offset !== 0)) {
		ctts = [];
		for (const offset of samples.offsets) {
			const last = ctts[ctts.length - 1];
			if (last && last[1] === offset) last[0]++;
			else ctts.push([1, offset]);
		}
	}
	const keyframes: number[] = [];
	const runs: Run[] = [];
	for (let index = 0; index < count; index++) {
		if (samples.sync[index]) keyframes.push(index);
		const position = samples.positions[index] as number;
		const last = runs[runs.length - 1];
		if (
			last &&
			(samples.positions[index - 1] as number) +
				(samples.sizes[index - 1] as number) ===
				position
		) {
			last.count++;
		} else {
			runs.push({ first: index, count: 1, offset: position });
		}
	}
	const sizes = Uint32Array.from(samples.sizes);
	const sourceEnd = samples.positions.reduce(
		(end, position, index) =>
			Math.max(end, position + (samples.sizes[index] as number)),
		0,
	);
	if (sourceEnd > provenance.size) {
		throw new UnsupportedSource("samples point past the end of the file");
	}

	const movieTimescale = new DataView(init.reuse.mvhd.buffer).getUint32(
		init.reuse.mvhd[8] === 1 ? 28 : 20,
	);
	const movieDuration = Math.round(
		(mediaDuration * movieTimescale) / init.timescale,
	);
	const ftyp = box(
		"ftyp",
		build((writer) => {
			writer.ascii("isom");
			writer.u32(0x200);
			writer.ascii("isomiso2avc1mp41");
		}),
	);
	const free = box(
		"free",
		new TextEncoder().encode(JSON.stringify(provenance)),
	);
	const make = (shift: number) =>
		box(
			"moov",
			patchDuration(init.reuse.mvhd, { v0: 24, v1: 32 }, movieDuration),
			box(
				"trak",
				patchDuration(init.reuse.tkhd, { v0: 28, v1: 36 }, movieDuration),
				box(
					"mdia",
					patchDuration(init.reuse.mdhd, { v0: 24, v1: 32 }, mediaDuration),
					init.reuse.hdlr,
					box(
						"minf",
						init.reuse.mediaHeader,
						init.reuse.dinf,
						sampleTable(
							{
								sizes,
								runs: runs.map((run) => ({
									...run,
									offset: run.offset + shift,
								})),
							},
							init.reuse.stsd,
							stts,
							Uint32Array.from(keyframes),
							ctts,
						),
					),
				),
			),
		);
	// co64 is fixed width, so the moov's size doesn't depend on the shift.
	const shift = ftyp.byteLength + free.byteLength + make(0).byteLength + 16;
	const moov = make(shift);
	const mdat = new Uint8Array(16);
	const mdatView = new DataView(mdat.buffer);
	mdatView.setUint32(0, 1);
	mdat.set(new TextEncoder().encode("mdat"), 4);
	mdatView.setBigUint64(8, BigInt(16 + provenance.size));
	const bytes = new Uint8Array(shift);
	let at = 0;
	for (const part of [ftyp, free, moov, mdat]) {
		bytes.set(part, at);
		at += part.byteLength;
	}
	if (at !== shift) throw new Error("prefix layout mismatch");

	const index: TrackIndex = {
		timescale: init.timescale,
		times: Float64Array.from(
			samples.dts,
			(dts, sample) =>
				(dts + (samples.offsets[sample] as number)) / init.timescale,
		),
		offsets: Float64Array.from(
			samples.positions,
			(position) => position + shift,
		),
		sizes,
		keyframes: Uint32Array.from(keyframes),
	};
	return { bytes, index };
}

/** Reads the provenance a prefix was built with, or null if it isn't one. */
export function prefixProvenance(prefix: Uint8Array): Provenance | null {
	const view = new DataView(
		prefix.buffer,
		prefix.byteOffset,
		prefix.byteLength,
	);
	const ftyp = boxAt(view, 0, prefix.byteLength);
	if (ftyp?.type !== "ftyp") return null;
	const free = boxAt(view, ftyp.end, prefix.byteLength);
	if (free?.type !== "free" || free.end > prefix.byteLength) return null;
	try {
		const parsed = JSON.parse(
			new TextDecoder().decode(prefix.subarray(free.body, free.end)),
		) as Provenance;
		return typeof parsed.version === "number" ? parsed : null;
	} catch {
		return null;
	}
}

class Bits {
	private bit = 0;
	constructor(private bytes: Uint8Array) {}

	u(count: number) {
		let value = 0;
		for (let index = 0; index < count; index++) {
			const byte = this.bytes[this.bit >> 3];
			if (byte === undefined) throw new UnsupportedSource("SPS ends early");
			value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
			this.bit++;
		}
		return value;
	}

	ue() {
		let zeros = 0;
		while (this.u(1) === 0) {
			if (++zeros > 31) throw new UnsupportedSource("bad exp-Golomb code");
		}
		return 2 ** zeros - 1 + this.u(zeros);
	}

	se() {
		const value = this.ue();
		return value % 2 === 1 ? (value + 1) / 2 : -value / 2;
	}
}

/** The fields of an H.264 SPS that decide how ffmpeg reports the stream. */
export function readSps(nal: Uint8Array) {
	// Drop emulation prevention bytes (00 00 03 -> 00 00) and the NAL header.
	const raw: number[] = [];
	for (let index = 1; index < nal.length; index++) {
		if (
			nal[index] === 3 &&
			nal[index - 1] === 0 &&
			nal[index - 2] === 0 &&
			index >= 3
		) {
			continue;
		}
		raw.push(nal[index] as number);
	}
	const bits = new Bits(Uint8Array.from(raw));
	const profile = bits.u(8);
	bits.u(16);
	bits.ue();
	let chromaFormat = 1;
	let lumaDepth = 8;
	let chromaDepth = 8;
	if (
		[100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(
			profile,
		)
	) {
		chromaFormat = bits.ue();
		if (chromaFormat === 3) bits.u(1);
		lumaDepth = bits.ue() + 8;
		chromaDepth = bits.ue() + 8;
		bits.u(1);
		if (bits.u(1)) {
			for (let list = 0; list < (chromaFormat === 3 ? 12 : 8); list++) {
				if (!bits.u(1)) continue;
				let last = 8;
				let next = 8;
				for (let index = 0; index < (list < 6 ? 16 : 64); index++) {
					if (next !== 0) next = (last + bits.se() + 256) % 256;
					last = next === 0 ? last : next;
				}
			}
		}
	}
	bits.ue();
	const pocType = bits.ue();
	if (pocType === 0) bits.ue();
	else if (pocType === 1) {
		bits.u(1);
		bits.se();
		bits.se();
		const cycle = bits.ue();
		for (let index = 0; index < cycle; index++) bits.se();
	}
	bits.ue();
	bits.u(1);
	bits.ue();
	bits.ue();
	if (!bits.u(1)) bits.u(1);
	bits.u(1);
	if (bits.u(1)) {
		bits.ue();
		bits.ue();
		bits.ue();
		bits.ue();
	}
	let fullRange = false;
	let reorderFrames: number | null = null;
	if (bits.u(1)) {
		if (bits.u(1) && bits.u(8) === 255) bits.u(32);
		if (bits.u(1)) bits.u(1);
		if (bits.u(1)) {
			bits.u(3);
			fullRange = bits.u(1) === 1;
			if (bits.u(1)) bits.u(24);
		}
		if (bits.u(1)) {
			bits.ue();
			bits.ue();
		}
		if (bits.u(1)) {
			bits.u(32);
			bits.u(32);
			bits.u(1);
		}
		const hrd = () => {
			const count = bits.ue() + 1;
			bits.u(8);
			for (let index = 0; index < count; index++) {
				bits.ue();
				bits.ue();
				bits.u(1);
			}
			bits.u(20);
		};
		const nalHrd = bits.u(1);
		if (nalHrd) hrd();
		const vclHrd = bits.u(1);
		if (vclHrd) hrd();
		if (nalHrd || vclHrd) bits.u(1);
		bits.u(1);
		if (bits.u(1)) {
			bits.u(1);
			bits.ue();
			bits.ue();
			bits.ue();
			bits.ue();
			reorderFrames = bits.ue();
		}
	}
	return {
		profile,
		chromaFormat,
		lumaDepth,
		chromaDepth,
		fullRange,
		reorderFrames,
	};
}

/**
 * Why the transcode task would re-encode this source rather than copy it
 * (see canRemux), or null when it would copy it: then the prefixed source
 * decodes to the same frames as the remux, and it's used as is.
 */
export function remuxBlocker(
	init: FragmentedInit,
	samples: FragmentSamples,
): string | null {
	if (init.codec !== "avc1" && init.codec !== "avc3") {
		return `codec ${init.codec}`;
	}
	const avcC = init.avcC;
	if (!avcC || avcC.byteLength < 8 || ((avcC[5] as number) & 0x1f) < 1) {
		return "no SPS";
	}
	const length = ((avcC[6] as number) << 8) | (avcC[7] as number);
	const sps = readSps(avcC.subarray(8, 8 + length));
	if (sps.chromaFormat !== 1 || sps.lumaDepth !== 8 || sps.chromaDepth !== 8) {
		return "not 8-bit 4:2:0";
	}
	if (sps.fullRange) return "full-range video";
	if (sps.reorderFrames) return "B-frames";
	if (samples.offsets.some((offset) => offset !== 0)) {
		return "presentation and decode times differ";
	}
	let previous = 0;
	let keyframes = 0;
	for (let index = 0; index < samples.count; index++) {
		if (!samples.sync[index]) continue;
		const time = (samples.dts[index] as number) / init.timescale;
		if (time - previous > MAX_REMUX_KEYFRAME_GAP_SECONDS) {
			return "keyframes too far apart";
		}
		previous = time;
		keyframes++;
	}
	if (keyframes === 0) return "no keyframes";
	const last = (samples.dts[samples.count - 1] as number) / init.timescale;
	if (last - previous > MAX_REMUX_KEYFRAME_GAP_SECONDS) {
		return "keyframes too far apart";
	}
	return null;
}

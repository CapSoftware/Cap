// Just enough ISO BMFF to (1) index a source recording from its moov alone,
// so chunk workers can download only the bytes their frames need, and (2)
// write the final export's ftyp+moov once every chunk has reported its
// sample table. The mdat is assembled by the chunk workers themselves as
// multipart parts, so this never touches media data.

import { MAX_SOURCE_PIXELS, MAX_SOURCE_SIDE } from "./transcode";

type Box = { type: string; start: number; headerSize: number; size: number };

function readBoxes(data: Uint8Array, start: number, end: number): Box[] {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const boxes: Box[] = [];
	let offset = start;
	while (offset + 8 <= end) {
		let size = view.getUint32(offset);
		const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
		let headerSize = 8;
		if (size === 1) {
			size = Number(view.getBigUint64(offset + 8));
			headerSize = 16;
		} else if (size === 0) {
			size = end - offset;
		}
		if (size < headerSize || offset + size > end) break;
		boxes.push({ type, start: offset, headerSize, size });
		offset += size;
	}
	return boxes;
}

function child(data: Uint8Array, box: Box, type: string, skip = 0) {
	return readBoxes(
		data,
		box.start + box.headerSize + skip,
		box.start + box.size,
	).find((candidate) => candidate.type === type);
}

function children(data: Uint8Array, box: Box, type: string) {
	return readBoxes(
		data,
		box.start + box.headerSize,
		box.start + box.size,
	).filter((candidate) => candidate.type === type);
}

function mediaHeader(data: Uint8Array, trak: Box) {
	const mdia = child(data, trak, "mdia");
	return mdia && child(data, mdia, "mdhd");
}

/** Top-level layout from the first bytes: where moov lives. */
export function locateMoov(head: Uint8Array, fileSize: number) {
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	let offset = 0;
	while (offset + 16 <= head.byteLength || offset + 8 <= head.byteLength) {
		let size = view.getUint32(offset);
		const type = String.fromCharCode(...head.subarray(offset + 4, offset + 8));
		if (size === 1) size = Number(view.getBigUint64(offset + 8));
		else if (size === 0) size = fileSize - offset;
		if (type === "moov") return { start: offset, size };
		if (size < 8) break;
		offset += size;
		if (offset >= fileSize) break;
		if (offset + 16 > head.byteLength) {
			// Past the head we fetched: the next box header is at `offset`.
			return { next: offset };
		}
	}
	return null;
}

export type TrackIndex = {
	timescale: number;
	/** Per sample, in decode order. */
	times: Float64Array;
	offsets: Float64Array;
	sizes: Uint32Array;
	keyframes: Uint32Array;
};

export class UnsupportedSource extends Error {}

// Sources are user uploads: a sample count drives several allocations, so it
// is capped (about 23 h at 60 fps), every table must fit inside its box, and
// the samples must fit inside the file, at least a byte each.
export const MAX_SAMPLES = 5_000_000;
export const MAX_SOURCE_SECONDS = MAX_SAMPLES / 60;

/**
 * Index the first video track of a moov box (bytes = the whole moov) in a
 * file of `fileSize` bytes.
 */
export function indexVideoTrack(
	moov: Uint8Array,
	fileSize: number,
): TrackIndex {
	const root = readBoxes(moov, 0, moov.byteLength).find(
		(box) => box.type === "moov",
	);
	if (!root) throw new UnsupportedSource("not a moov box");
	const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
	// The engine's probe sizes the timeline from the longest track's header.
	for (const trak of children(moov, root, "trak")) {
		const mdhd = mediaHeader(moov, trak);
		if (!mdhd) continue;
		const body = mdhd.start + mdhd.headerSize;
		const long = moov[body] === 1;
		if (mdhd.size - mdhd.headerSize < (long ? 32 : 20)) {
			throw new UnsupportedSource("mdhd is too short");
		}
		const timescale = view.getUint32(body + (long ? 20 : 12));
		const duration = long
			? Number(view.getBigUint64(body + 24))
			: view.getUint32(body + 16);
		if (duration > timescale * MAX_SOURCE_SECONDS) {
			throw new UnsupportedSource(
				`a ${Math.round(duration / timescale)} s track`,
			);
		}
	}
	for (const trak of children(moov, root, "trak")) {
		const mdia = child(moov, trak, "mdia");
		if (!mdia) continue;
		const hdlr = child(moov, mdia, "hdlr");
		if (!hdlr) continue;
		const handler = String.fromCharCode(
			...moov.subarray(
				hdlr.start + hdlr.headerSize + 8,
				hdlr.start + hdlr.headerSize + 12,
			),
		);
		if (handler !== "vide") continue;
		const mdhd = child(moov, mdia, "mdhd");
		const minf = child(moov, mdia, "minf");
		const stbl = minf && child(moov, minf, "stbl");
		if (!mdhd || !stbl) continue;
		const version = moov[mdhd.start + mdhd.headerSize] ?? 0;
		const timescale = view.getUint32(
			mdhd.start + mdhd.headerSize + (version === 1 ? 20 : 12),
		);
		if (!timescale) throw new UnsupportedSource("zero timescale");
		// Full-box tables: `countAt` bytes into the body sits the entry count,
		// and `entrySize`-byte entries follow it.
		const table = (type: string, countAt: number, entrySize: number) => {
			const box = child(moov, stbl, type);
			if (!box) return null;
			const body = box.start + box.headerSize;
			const entries = view.getUint32(body + countAt);
			if (
				countAt + 4 + entries * entrySize > box.size - box.headerSize ||
				entries > MAX_SAMPLES
			) {
				throw new UnsupportedSource(`${type} lists more entries than it holds`);
			}
			return { body, entries };
		};

		const stszBox = child(moov, stbl, "stsz");
		if (!stszBox) throw new UnsupportedSource("no stsz");
		const stsz = stszBox.start + stszBox.headerSize;
		const uniform = view.getUint32(stsz + 4);
		const count = view.getUint32(stsz + 8);
		if (count > MAX_SAMPLES) {
			throw new UnsupportedSource(`${count} video samples`);
		}
		let mediaBytes = uniform * count;
		if (!uniform) {
			table("stsz", 8, 4);
			for (let index = 0; index < count; index++) {
				mediaBytes += view.getUint32(stsz + 12 + index * 4);
			}
		}
		if (Math.max(count, mediaBytes) > fileSize) {
			throw new UnsupportedSource(
				`${count} video samples of ${mediaBytes} bytes in a ${fileSize} byte file`,
			);
		}

		const sttsTable = table("stts", 4, 8);
		let duration = 0;
		for (let entry = 0; sttsTable && entry < sttsTable.entries; entry++) {
			const at = sttsTable.body + 8 + entry * 8;
			duration += view.getUint32(at) * view.getUint32(at + 4);
		}
		if (duration / timescale > MAX_SOURCE_SECONDS) {
			throw new UnsupportedSource(
				`a ${Math.round(duration / timescale)} s video track`,
			);
		}

		const stsd = child(moov, stbl, "stsd");
		const entry =
			stsd &&
			readBoxes(
				moov,
				stsd.start + stsd.headerSize + 8,
				stsd.start + stsd.size,
			)[0];
		if (entry && entry.size >= entry.headerSize + 28) {
			const width = view.getUint16(entry.start + entry.headerSize + 24);
			const height = view.getUint16(entry.start + entry.headerSize + 26);
			if (
				width * height > MAX_SOURCE_PIXELS ||
				Math.max(width, height) > MAX_SOURCE_SIDE
			) {
				throw new UnsupportedSource(`a ${width}x${height} video track`);
			}
		}

		const sizes = new Uint32Array(count);
		for (let index = 0; index < count; index++) {
			sizes[index] = uniform || view.getUint32(stsz + 12 + index * 4);
		}

		const times = new Float64Array(count);
		if (sttsTable !== null) {
			const { body: stts, entries } = sttsTable;
			let sample = 0;
			let time = 0;
			for (let entry = 0; entry < entries; entry++) {
				const sampleCount = view.getUint32(stts + 8 + entry * 8);
				const delta = view.getUint32(stts + 12 + entry * 8);
				for (let index = 0; index < sampleCount && sample < count; index++) {
					times[sample++] = time / timescale;
					time += delta;
				}
			}
		}

		const chunkOffsets: number[] = [];
		const stco = table("stco", 4, 4);
		const co64 = stco ? null : table("co64", 4, 8);
		if (stco !== null) {
			for (let index = 0; index < stco.entries; index++) {
				chunkOffsets.push(view.getUint32(stco.body + 8 + index * 4));
			}
		} else if (co64 !== null) {
			for (let index = 0; index < co64.entries; index++) {
				chunkOffsets.push(Number(view.getBigUint64(co64.body + 8 + index * 8)));
			}
		}
		const stscTable = table("stsc", 4, 12);
		if (stscTable === null) throw new UnsupportedSource("no stsc");
		const { body: stsc, entries: stscEntries } = stscTable;
		const offsets = new Float64Array(count);
		let sample = 0;
		for (let entry = 0; entry < stscEntries; entry++) {
			const firstChunk = view.getUint32(stsc + 8 + entry * 12) - 1;
			const perChunk = view.getUint32(stsc + 12 + entry * 12);
			const lastChunk = Math.min(
				chunkOffsets.length,
				entry + 1 < stscEntries
					? view.getUint32(stsc + 8 + (entry + 1) * 12) - 1
					: chunkOffsets.length,
			);
			for (
				let chunk = firstChunk;
				chunk < lastChunk && sample < count;
				chunk++
			) {
				let offset = chunkOffsets[chunk] ?? 0;
				for (let index = 0; index < perChunk && sample < count; index++) {
					offsets[sample] = offset;
					offset += sizes[sample] ?? 0;
					sample++;
				}
				if (offset > fileSize) {
					throw new UnsupportedSource(`chunk ${chunk + 1} ends past the file`);
				}
			}
		}

		const stssTable = table("stss", 4, 4);
		let keyframes: Uint32Array;
		if (stssTable === null) {
			keyframes = Uint32Array.from({ length: count }, (_, index) => index);
		} else {
			const { body: stss, entries } = stssTable;
			if (entries > count) {
				throw new UnsupportedSource(`${entries} keyframes of ${count} samples`);
			}
			keyframes = new Uint32Array(entries);
			for (let index = 0; index < entries; index++) {
				keyframes[index] = view.getUint32(stss + 8 + index * 4) - 1;
			}
		}
		return { timescale, times, offsets, sizes, keyframes };
	}
	throw new UnsupportedSource("no video track");
}

/**
 * Byte range covering every sample a decoder needs for [from, to] seconds:
 * back to the keyframe at or before `from`, forward through `to`.
 */
export function byteRangeFor(index: TrackIndex, from: number, to: number) {
	const count = index.times.length;
	if (count === 0) return null;
	// Last keyframe at or before `from`. Planning calls this once per 2 s span
	// per source file, so a linear scan was O(keyframes) each time (~0.5 s of
	// planning for a 2 h export).
	let low = 0;
	let high = index.keyframes.length - 1;
	let first = 0;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const key = index.keyframes[middle] ?? 0;
		if ((index.times[key] ?? 0) <= from) {
			first = key;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	let last = count - 1;
	for (let sample = first; sample < count; sample++) {
		if ((index.times[sample] ?? 0) > to) {
			last = sample;
			break;
		}
	}
	let start = Number.POSITIVE_INFINITY;
	let end = 0;
	for (let sample = first; sample <= last; sample++) {
		const offset = index.offsets[sample] ?? 0;
		start = Math.min(start, offset);
		end = Math.max(end, offset + (index.sizes[sample] ?? 0));
	}
	return { start, end };
}

// ---------------------------------------------------------------- writer ---

class Writer {
	private chunks: Uint8Array[] = [];
	length = 0;

	bytes(value: Uint8Array) {
		this.chunks.push(value);
		this.length += value.byteLength;
	}

	u8(value: number) {
		this.bytes(Uint8Array.of(value & 0xff));
	}

	u16(value: number) {
		const buffer = new Uint8Array(2);
		new DataView(buffer.buffer).setUint16(0, value);
		this.bytes(buffer);
	}

	u32(value: number) {
		const buffer = new Uint8Array(4);
		new DataView(buffer.buffer).setUint32(0, value >>> 0);
		this.bytes(buffer);
	}

	u64(value: number) {
		const buffer = new Uint8Array(8);
		new DataView(buffer.buffer).setBigUint64(0, BigInt(value));
		this.bytes(buffer);
	}

	i16(value: number) {
		const buffer = new Uint8Array(2);
		new DataView(buffer.buffer).setInt16(0, value);
		this.bytes(buffer);
	}

	ascii(value: string) {
		this.bytes(new TextEncoder().encode(value));
	}

	zeros(count: number) {
		this.bytes(new Uint8Array(count));
	}

	finish() {
		const out = new Uint8Array(this.length);
		let offset = 0;
		for (const chunk of this.chunks) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return out;
	}
}

export function box(type: string, ...parts: Uint8Array[]) {
	const writer = new Writer();
	const length = parts.reduce((sum, part) => sum + part.byteLength, 8);
	writer.u32(length);
	writer.ascii(type);
	for (const part of parts) writer.bytes(part);
	return writer.finish();
}

export function fullBox(
	type: string,
	version: number,
	flags: number,
	...parts: Uint8Array[]
) {
	const header = new Writer();
	header.u8(version);
	header.u8(flags >> 16);
	header.u16(flags & 0xffff);
	return box(type, header.finish(), ...parts);
}

export function build(fn: (writer: Writer) => void) {
	const writer = new Writer();
	fn(writer);
	return writer.finish();
}

export const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

/** Annex B SPS/PPS -> avcC. */
export function avcC(annexB: Uint8Array) {
	const nals: Uint8Array[] = [];
	let index = 0;
	const starts: [number, number][] = [];
	while (index + 3 <= annexB.length) {
		if (annexB[index] === 0 && annexB[index + 1] === 0) {
			if (annexB[index + 2] === 1) {
				starts.push([index, 3]);
				index += 3;
				continue;
			}
			if (annexB[index + 2] === 0 && annexB[index + 3] === 1) {
				starts.push([index, 4]);
				index += 4;
				continue;
			}
		}
		index++;
	}
	for (let position = 0; position < starts.length; position++) {
		const [start, prefix] = starts[position] as [number, number];
		const end = starts[position + 1]?.[0] ?? annexB.length;
		nals.push(annexB.subarray(start + prefix, end));
	}
	const sps = nals.filter((nal) => ((nal[0] ?? 0) & 0x1f) === 7);
	const pps = nals.filter((nal) => ((nal[0] ?? 0) & 0x1f) === 8);
	const first = sps[0];
	if (!first) throw new Error("no SPS in encoder extradata");
	return build((writer) => {
		writer.u8(1);
		writer.u8(first[1] ?? 0);
		writer.u8(first[2] ?? 0);
		writer.u8(first[3] ?? 0);
		writer.u8(0xff);
		writer.u8(0xe0 | sps.length);
		for (const nal of sps) {
			writer.u16(nal.length);
			writer.bytes(nal);
		}
		writer.u8(pps.length);
		for (const nal of pps) {
			writer.u16(nal.length);
			writer.bytes(nal);
		}
		const profile = first[1] ?? 0;
		if ([100, 110, 122, 144].includes(profile)) {
			writer.u8(0xfc | 1);
			writer.u8(0xf8);
			writer.u8(0xf8);
			writer.u8(0);
		}
	});
}

export function esds(asc: Uint8Array, bitrate: number) {
	const descriptor = (tag: number, body: Uint8Array) =>
		build((writer) => {
			writer.u8(tag);
			writer.u8(0x80);
			writer.u8(0x80);
			writer.u8(0x80);
			writer.u8(body.length);
			writer.bytes(body);
		});
	const decoderSpecific = descriptor(0x05, asc);
	const decoderConfig = descriptor(
		0x04,
		build((writer) => {
			writer.u8(0x40);
			writer.u8(0x15);
			writer.u8(0);
			writer.u16(0);
			writer.u32(bitrate);
			writer.u32(bitrate);
			writer.bytes(decoderSpecific);
		}),
	);
	const sl = descriptor(0x06, Uint8Array.of(2));
	const es = descriptor(
		0x03,
		build((writer) => {
			writer.u16(2);
			writer.u8(0);
			writer.bytes(decoderConfig);
			writer.bytes(sl);
		}),
	);
	return fullBox("esds", 0, 0, es);
}

/** Consecutive runs of samples in the file ("chunks" in MP4 terms). */
export type Run = { first: number; count: number; offset: number };

export type TrackTable = {
	sizes: Uint32Array;
	runs: Run[];
};

/** Runs as columns: run `index` is `counts[index]` samples from `offsets[index]`. */
export type RunColumns = { counts: Uint32Array; offsets: Float64Array };

export function runColumns(runs: Run[]): RunColumns {
	return {
		counts: Uint32Array.from(runs, (run) => run.count),
		offsets: Float64Array.from(runs, (run) => run.offset),
	};
}

/** A full box of `bytes` body bytes that `fill` writes. */
function tableBox(
	type: string,
	version: number,
	bytes: number,
	fill: (view: DataView) => void,
) {
	const body = new Uint8Array(bytes);
	fill(new DataView(body.buffer));
	return fullBox(type, version, 0, body);
}

/**
 * `stts` and `ctts` are flat [count, value] pairs, and every run offset is
 * moved by `table.shift`. Tables go straight from typed arrays into their
 * box: a source can list millions of samples, and a JS value per entry costs
 * GBs.
 */
export function sampleTable(
	table: { sizes: Uint32Array; runs: RunColumns; shift: number },
	stsd: Uint8Array,
	stts: Uint32Array,
	sync: Uint32Array | null,
	// Negative composition offsets need a v1 ctts box.
	ctts: Int32Array | null = null,
) {
	const parts: Uint8Array[] = [stsd];
	const pairs = (
		type: string,
		version: number,
		values: Uint32Array | Int32Array,
	) =>
		tableBox(type, version, 4 + values.length * 4, (view) => {
			view.setUint32(0, values.length / 2);
			for (let index = 0; index < values.length; index++) {
				view.setUint32(4 + index * 4, (values[index] as number) >>> 0);
			}
		});
	parts.push(pairs("stts", 0, stts));
	if (ctts) {
		let negative = false;
		for (let index = 1; index < ctts.length; index += 2) {
			if ((ctts[index] as number) < 0) negative = true;
		}
		parts.push(pairs("ctts", negative ? 1 : 0, ctts));
	}
	if (sync) {
		parts.push(
			tableBox("stss", 0, 4 + sync.length * 4, (view) => {
				view.setUint32(0, sync.length);
				sync.forEach((sample, index) => {
					view.setUint32(4 + index * 4, sample + 1);
				});
			}),
		);
	}
	const { counts, offsets } = table.runs;
	let stscEntries = 0;
	for (let index = 0; index < counts.length; index++) {
		if (index === 0 || counts[index] !== counts[index - 1]) stscEntries++;
	}
	parts.push(
		tableBox("stsc", 0, 4 + stscEntries * 12, (view) => {
			view.setUint32(0, stscEntries);
			let at = 4;
			for (let index = 0; index < counts.length; index++) {
				if (index > 0 && counts[index] === counts[index - 1]) continue;
				view.setUint32(at, index + 1);
				view.setUint32(at + 4, counts[index] as number);
				view.setUint32(at + 8, 1);
				at += 12;
			}
		}),
	);
	parts.push(
		tableBox("stsz", 0, 8 + table.sizes.length * 4, (view) => {
			view.setUint32(4, table.sizes.length);
			table.sizes.forEach((size, index) => {
				view.setUint32(8 + index * 4, size);
			});
		}),
	);
	parts.push(
		tableBox("co64", 0, 4 + offsets.length * 8, (view) => {
			view.setUint32(0, offsets.length);
			offsets.forEach((offset, index) => {
				view.setBigUint64(4 + index * 8, BigInt(offset + table.shift));
			});
		}),
	);
	return box("stbl", ...parts);
}

export function dinf() {
	return box(
		"dinf",
		fullBox(
			"dref",
			0,
			0,
			build((writer) => writer.u32(1)),
			fullBox("url ", 0, 1),
		),
	);
}

export const tkhd = (
	id: number,
	duration: number,
	audio: boolean,
	width: number,
	height: number,
) =>
	fullBox(
		"tkhd",
		0,
		3,
		build((writer) => {
			writer.u32(0);
			writer.u32(0);
			writer.u32(id);
			writer.u32(0);
			writer.u32(duration);
			writer.zeros(8);
			writer.u16(0);
			writer.u16(audio ? 1 : 0);
			writer.u16(audio ? 0x100 : 0);
			writer.u16(0);
			for (const value of MATRIX) writer.u32(value);
			writer.u32(audio ? 0 : width << 16);
			writer.u32(audio ? 0 : height << 16);
		}),
	);

export const mdhd = (timescale: number, duration: number) =>
	fullBox(
		"mdhd",
		0,
		0,
		build((writer) => {
			writer.u32(0);
			writer.u32(0);
			writer.u32(timescale);
			writer.u32(duration);
			writer.u16(0x55c4);
			writer.u16(0);
		}),
	);

export const hdlr = (type: string, name: string) =>
	fullBox(
		"hdlr",
		0,
		0,
		build((writer) => {
			writer.u32(0);
			writer.ascii(type);
			writer.zeros(12);
			writer.ascii(name);
			writer.u8(0);
		}),
	);

export const avc1 = (width: number, height: number, avcCBytes: Uint8Array) =>
	box(
		"avc1",
		build((writer) => {
			writer.zeros(6);
			writer.u16(1);
			writer.zeros(16);
			writer.u16(width);
			writer.u16(height);
			writer.u32(0x480000);
			writer.u32(0x480000);
			writer.u32(0);
			writer.u16(1);
			writer.zeros(32);
			writer.u16(0x18);
			writer.i16(-1);
		}),
		box("avcC", avcCBytes),
		box(
			"colr",
			build((writer) => {
				writer.ascii("nclx");
				writer.u16(1);
				writer.u16(1);
				writer.u16(1);
				writer.u8(0);
			}),
		),
		box(
			"pasp",
			build((writer) => {
				writer.u32(1);
				writer.u32(1);
			}),
		),
	);

export const mp4a = (asc: Uint8Array) =>
	box(
		"mp4a",
		build((writer) => {
			writer.zeros(6);
			writer.u16(1);
			writer.zeros(8);
			writer.u16(2);
			writer.u16(16);
			writer.zeros(4);
			writer.u32(48000 << 16);
		}),
		esds(asc, 320_000),
	);

export type HeaderInput = {
	width: number;
	height: number;
	fps: number;
	video: TrackTable & { keyframes: Uint32Array; avcC: Uint8Array };
	audio:
		| (TrackTable & { asc: Uint8Array; totalSamples: number; priming: number })
		| null;
	/** Bytes of media data that follow the header (sum of all chunk parts). */
	payloadSize: number;
	/** Pad the header to at least this many bytes (S3's 5 MiB part minimum). */
	minimumSize: number;
};

/**
 * ftyp + moov + free padding + mdat header. Run offsets in `input` are
 * relative to the start of the mdat payload; they are rebased here.
 */
export function buildHeader(input: HeaderInput) {
	const videoTimescale = input.fps * 1000;
	const frameCount = input.video.sizes.length;
	const videoDuration = frameCount * 1000;
	const durationMs = Math.round((frameCount / input.fps) * 1000);

	const videoRuns = runColumns(input.video.runs);
	const audioRuns = input.audio && runColumns(input.audio.runs);
	const make = (headerSize: number) => {
		const ftyp = box(
			"ftyp",
			build((writer) => {
				writer.ascii("isom");
				writer.u32(0x200);
				writer.ascii("isomiso2avc1mp41");
			}),
		);
		const mvhd = fullBox(
			"mvhd",
			0,
			0,
			build((writer) => {
				writer.u32(0);
				writer.u32(0);
				writer.u32(1000);
				writer.u32(durationMs);
				writer.u32(0x10000);
				writer.u16(0x100);
				writer.zeros(10);
				for (const value of MATRIX) writer.u32(value);
				writer.zeros(24);
				writer.u32(input.audio ? 3 : 2);
			}),
		);
		const videoTrak = box(
			"trak",
			tkhd(1, durationMs, false, input.width, input.height),
			box(
				"mdia",
				mdhd(videoTimescale, videoDuration),
				hdlr("vide", "VideoHandler"),
				box(
					"minf",
					fullBox("vmhd", 0, 1, new Uint8Array(8)),
					dinf(),
					sampleTable(
						{ sizes: input.video.sizes, runs: videoRuns, shift: headerSize },
						fullBox(
							"stsd",
							0,
							0,
							build((writer) => writer.u32(1)),
							avc1(input.width, input.height, input.video.avcC),
						),
						Uint32Array.of(frameCount, 1000),
						input.video.keyframes,
					),
				),
			),
		);

		const tracks = [videoTrak];
		if (input.audio && audioRuns) {
			const audio = input.audio;
			const packets = audio.sizes.length;
			const mediaDuration = packets * 1024;
			// Skip the encoder's priming samples and trim the padded tail, like
			// ffmpeg's MP4 muxer does for AAC.
			const elst = box(
				"edts",
				fullBox(
					"elst",
					0,
					0,
					build((writer) => {
						writer.u32(1);
						writer.u32(Math.round((audio.totalSamples / 48000) * 1000));
						writer.u32(audio.priming);
						writer.u16(1);
						writer.u16(0);
					}),
				),
			);
			tracks.push(
				box(
					"trak",
					tkhd(2, Math.round((audio.totalSamples / 48000) * 1000), true, 0, 0),
					elst,
					box(
						"mdia",
						mdhd(48000, mediaDuration),
						hdlr("soun", "SoundHandler"),
						box(
							"minf",
							fullBox("smhd", 0, 0, new Uint8Array(4)),
							dinf(),
							sampleTable(
								{ sizes: audio.sizes, runs: audioRuns, shift: headerSize },
								fullBox(
									"stsd",
									0,
									0,
									build((writer) => writer.u32(1)),
									mp4a(audio.asc),
								),
								Uint32Array.of(packets, 1024),
								null,
							),
						),
					),
				),
			);
		}
		const moov = box("moov", mvhd, ...tracks);
		return { ftyp, moov };
	};

	// The moov's size doesn't depend on the offsets (co64 is fixed width), so
	// measure once, then lay out: ftyp, moov, free padding only when a minimum
	// size asks for it, 16-byte mdat header.
	const probe = make(0);
	const bare = probe.ftyp.byteLength + probe.moov.byteLength + 16;
	const headerSize =
		input.minimumSize <= bare ? bare : Math.max(input.minimumSize, bare + 8);
	const final = make(headerSize);
	const freeSize =
		headerSize - final.ftyp.byteLength - final.moov.byteLength - 16;
	const free = new Uint8Array(freeSize);
	if (freeSize > 0) {
		new DataView(free.buffer).setUint32(0, freeSize);
		free.set(new TextEncoder().encode("free"), 4);
	}
	const mdat = new Uint8Array(16);
	const mdatView = new DataView(mdat.buffer);
	mdatView.setUint32(0, 1);
	mdat.set(new TextEncoder().encode("mdat"), 4);
	mdatView.setBigUint64(8, BigInt(16 + input.payloadSize));
	const out = new Uint8Array(headerSize);
	let offset = 0;
	for (const part of [final.ftyp, final.moov, free, mdat]) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	if (offset !== headerSize) throw new Error("header layout mismatch");
	return out;
}

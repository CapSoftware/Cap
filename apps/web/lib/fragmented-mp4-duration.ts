export type ReadRange = (start: number, end: number) => Promise<Uint8Array>;

export interface FragmentedTrackTiming {
	timescale: number;
	defaultSampleDuration?: number;
}

export class FragmentedMp4Error extends Error {}

const HEADER_WINDOW_BYTES = 64 * 1024;
const MAX_BOX_READ_BYTES = 8 * 1024 * 1024;

interface Box {
	type: string;
	start: number;
	contentStart: number;
	end: number;
}

function readBoxHeader(bytes: Uint8Array, offset: number) {
	if (offset + 8 > bytes.byteLength)
		throw new FragmentedMp4Error("Truncated MP4 box header");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
	const declared = view.getUint32(offset);
	if (declared !== 1) return { type, size: declared, header: 8 };
	if (offset + 16 > bytes.byteLength)
		throw new FragmentedMp4Error("Truncated MP4 box header");
	const large = view.getBigUint64(offset + 8);
	if (large > BigInt(Number.MAX_SAFE_INTEGER))
		throw new FragmentedMp4Error("MP4 box is too large");
	return { type, size: Number(large), header: 16 };
}

function readBox(bytes: Uint8Array, offset: number, limit: number): Box {
	const header = readBoxHeader(bytes, offset);
	const size = header.size === 0 ? limit - offset : header.size;
	if (size < header.header || offset + size > limit)
		throw new FragmentedMp4Error(`Invalid MP4 ${header.type} box size`);
	return {
		type: header.type,
		start: offset,
		contentStart: offset + header.header,
		end: offset + size,
	};
}

function children(bytes: Uint8Array, box: Pick<Box, "contentStart" | "end">) {
	const result: Box[] = [];
	for (let offset = box.contentStart; offset < box.end; ) {
		const child = readBox(bytes, offset, box.end);
		result.push(child);
		offset = child.end;
	}
	return result;
}

function child(bytes: Uint8Array, box: Box, type: string) {
	return children(bytes, box).find((entry) => entry.type === type);
}

function fullBox(bytes: Uint8Array, box: Box) {
	if (box.contentStart + 4 > box.end)
		throw new FragmentedMp4Error(`Truncated MP4 ${box.type} box`);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const word = view.getUint32(box.contentStart);
	return {
		view,
		version: word >>> 24,
		flags: word & 0xffffff,
		body: box.contentStart + 4,
	};
}

export function readInitTiming(bytes: Uint8Array): FragmentedTrackTiming {
	const top = children(bytes, { contentStart: 0, end: bytes.byteLength });
	const moov = top.find((box) => box.type === "moov");
	if (!moov) throw new FragmentedMp4Error("Init segment has no moov box");
	const traks = children(bytes, moov).filter((box) => box.type === "trak");
	if (traks.length !== 1)
		throw new FragmentedMp4Error("Init segment must hold exactly one track");
	const mdia = child(bytes, traks[0] as Box, "mdia");
	const mdhd = mdia && child(bytes, mdia, "mdhd");
	if (!mdhd) throw new FragmentedMp4Error("Init segment has no mdhd box");
	const header = fullBox(bytes, mdhd);
	const timescaleOffset = header.body + (header.version === 1 ? 16 : 8);
	if (timescaleOffset + 4 > mdhd.end)
		throw new FragmentedMp4Error("Truncated mdhd box");
	const timescale = header.view.getUint32(timescaleOffset);
	if (timescale === 0) throw new FragmentedMp4Error("Track timescale is zero");

	const mvex = child(bytes, moov, "mvex");
	const trex = mvex && child(bytes, mvex, "trex");
	if (!trex) return { timescale };
	const defaults = fullBox(bytes, trex);
	if (defaults.body + 12 > trex.end)
		throw new FragmentedMp4Error("Truncated trex box");
	const defaultSampleDuration = defaults.view.getUint32(defaults.body + 8);
	return defaultSampleDuration > 0
		? { timescale, defaultSampleDuration }
		: { timescale };
}

function moofTicks(
	bytes: Uint8Array,
	moof: Box,
	timing: FragmentedTrackTiming,
) {
	let ticks = 0;
	for (const traf of children(bytes, moof).filter(
		(box) => box.type === "traf",
	)) {
		const tfhd = child(bytes, traf, "tfhd");
		if (!tfhd) throw new FragmentedMp4Error("Fragment has no tfhd box");
		const header = fullBox(bytes, tfhd);
		let offset = header.body + 4;
		if (header.flags & 0x01) offset += 8;
		if (header.flags & 0x02) offset += 4;
		let defaultDuration = timing.defaultSampleDuration;
		if (header.flags & 0x08) {
			if (offset + 4 > tfhd.end)
				throw new FragmentedMp4Error("Truncated tfhd box");
			defaultDuration = header.view.getUint32(offset);
		}
		for (const trun of children(bytes, traf).filter(
			(box) => box.type === "trun",
		)) {
			const run = fullBox(bytes, trun);
			if (run.body + 4 > trun.end)
				throw new FragmentedMp4Error("Truncated trun box");
			const count = run.view.getUint32(run.body);
			let cursor = run.body + 4;
			if (run.flags & 0x01) cursor += 4;
			if (run.flags & 0x04) cursor += 4;
			const fields = [0x100, 0x200, 0x400, 0x800].filter(
				(flag) => run.flags & flag,
			);
			if (cursor + count * fields.length * 4 > trun.end)
				throw new FragmentedMp4Error("Truncated trun samples");
			if (!(run.flags & 0x100)) {
				if (!defaultDuration)
					throw new FragmentedMp4Error("Fragment samples have no duration");
				ticks += count * defaultDuration;
				continue;
			}
			for (let sample = 0; sample < count; sample++) {
				ticks += run.view.getUint32(cursor);
				cursor += fields.length * 4;
			}
		}
	}
	return ticks;
}

export async function readFragmentDuration(
	read: ReadRange,
	size: number,
	timing: FragmentedTrackTiming,
): Promise<number> {
	let ticks = 0;
	let moofs = 0;
	let window: Uint8Array = new Uint8Array();
	let windowStart = 0;
	for (let offset = 0; offset < size; ) {
		if (offset + 16 > windowStart + window.byteLength) {
			windowStart = offset;
			window = await read(offset, Math.min(size, offset + HEADER_WINDOW_BYTES));
			if (window.byteLength === 0)
				throw new FragmentedMp4Error("Segment read returned no data");
		}
		const header = readBoxHeader(window, offset - windowStart);
		const boxSize = header.size === 0 ? size - offset : header.size;
		if (boxSize < header.header || offset + boxSize > size)
			throw new FragmentedMp4Error(`Invalid MP4 ${header.type} box size`);
		if (header.type === "moof") {
			if (boxSize > MAX_BOX_READ_BYTES)
				throw new FragmentedMp4Error("Fragment header is too large");
			const inWindow = offset + boxSize <= windowStart + window.byteLength;
			const bytes = inWindow ? window : await read(offset, offset + boxSize);
			const start = inWindow ? offset - windowStart : 0;
			ticks += moofTicks(bytes, readBox(bytes, start, start + boxSize), timing);
			moofs++;
		}
		offset += boxSize;
	}
	if (moofs === 0) throw new FragmentedMp4Error("Segment has no moof box");
	if (ticks <= 0) throw new FragmentedMp4Error("Segment has no samples");
	return ticks / timing.timescale;
}

import { fragmentedMp4Init } from "./fragmented-mp4-duration";

/// Byte-level helpers that let the editor seek inside a long fragmented MP4
/// recording without reading everything before the seek point. Older
/// recordings have no fragment index (`mfra`/`sidx`), and mediabunny finds a
/// time by walking every fragment from the start of the file, so a seek an
/// hour in downloads half a gigabyte. Here a fragment near the target is found
/// from the `mfra` the recorder appends, or from a few small reads without
/// one, and the decoder gets a virtual file that starts there.

export type Box = { type: string; start: number; end: number; body: number };

function type4(bytes: Uint8Array, at: number) {
	return String.fromCharCode(
		bytes[at] ?? 0,
		bytes[at + 1] ?? 0,
		bytes[at + 2] ?? 0,
		bytes[at + 3] ?? 0,
	);
}

export function boxAt(view: DataView, offset: number, end: number): Box | null {
	if (offset + 8 > end) return null;
	let size = view.getUint32(offset);
	let body = offset + 8;
	if (size === 1) {
		if (offset + 16 > end) return null;
		size = Number(view.getBigUint64(offset + 8));
		body = offset + 16;
	} else if (size === 0) {
		return null;
	}
	if (size < body - offset) return null;
	return {
		type: type4(
			new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
			offset + 4,
		),
		start: offset,
		end: offset + size,
		body,
	};
}

export function children(view: DataView, parent: Box) {
	const out: Box[] = [];
	let offset = parent.body;
	while (offset < parent.end) {
		const box = boxAt(view, offset, parent.end);
		if (!box || box.end > parent.end) return null;
		out.push(box);
		offset = box.end;
	}
	return out;
}

export type Mp4SeekInfo = {
	/// Offset just past the `moov` box: ftyp + moov form the init bytes a
	/// virtual file starts with.
	moovEnd: number;
	videoTrackId: number;
	timescale: number;
	/// `trex` default sample flags for the video track.
	defaultSampleFlags: number;
	trackIds: number[];
};

/// Video track timing from the start of a fragmented MP4, or null when the
/// bytes do not hold a complete fragmented `moov` with one video track and no
/// edit lists.
export function mp4SeekInfo(head: Uint8Array): Mp4SeekInfo | null {
	const init = fragmentedMp4Init(head);
	if (!init) return null;
	const video = [...init.tracks].filter(
		([, track]) => track.handler === "vide",
	);
	const [entry] = video;
	if (video.length !== 1 || !entry) return null;
	const [videoTrackId, track] = entry;
	return {
		moovEnd: init.moovEnd,
		videoTrackId,
		timescale: track.timescale,
		defaultSampleFlags: track.defaultSampleFlags,
		trackIds: [...init.tracks.keys()],
	};
}

export type FragmentPoint = {
	/// File offset of the fragment's `moof`.
	offset: number;
	/// Presentation time in seconds of the fragment's first video sample.
	time: number;
	/// The first video sample is a sync sample, so decoding can start here.
	keyframe: boolean;
	/// Sample data is addressed from this fragment (default-base-is-moof or
	/// implicit), so the fragment reads the same wherever it sits in a file.
	relocatable: boolean;
	/// Offset just past the fragment's `mdat`.
	end: number;
};

const NON_SYNC_SAMPLE = 0x10000;
const MAX_MOOF_BYTES = 4 * 1024 * 1024;

function videoFragment(
	view: DataView,
	moof: Box,
	info: Mp4SeekInfo,
): Omit<FragmentPoint, "end"> | null {
	const moofChildren = children(view, moof);
	if (!moofChildren || moofChildren[0]?.type !== "mfhd") return null;
	let point: Omit<FragmentPoint, "end"> | null = null;
	let relocatable = true;
	for (const traf of moofChildren) {
		if (traf.type !== "traf") continue;
		const trafChildren = children(view, traf);
		const tfhd = trafChildren?.find((box) => box.type === "tfhd");
		if (!trafChildren || !tfhd) return null;
		const tfhdFlags = view.getUint32(tfhd.body) & 0xffffff;
		const trackId = view.getUint32(tfhd.body + 4);
		if (!info.trackIds.includes(trackId)) return null;
		if (tfhdFlags & 0x1) relocatable = false;
		if (trackId !== info.videoTrackId) continue;
		const tfdt = trafChildren.find((box) => box.type === "tfdt");
		const trun = trafChildren.find((box) => box.type === "trun");
		if (!tfdt || !trun) return null;
		let flags = info.defaultSampleFlags;
		if (tfhdFlags & 0x20) {
			let field = tfhd.body + 8;
			if (tfhdFlags & 0x1) field += 8;
			if (tfhdFlags & 0x2) field += 4;
			if (tfhdFlags & 0x8) field += 4;
			if (tfhdFlags & 0x10) field += 4;
			flags = view.getUint32(field);
		}
		const decodeTime =
			view.getUint8(tfdt.body) === 1
				? Number(view.getBigUint64(tfdt.body + 4))
				: view.getUint32(tfdt.body + 4);
		const trunVersion = view.getUint8(trun.body);
		const trunFlags = view.getUint32(trun.body) & 0xffffff;
		if (view.getUint32(trun.body + 4) < 1) return null;
		let field = trun.body + 8;
		if (trunFlags & 0x1) field += 4;
		if (trunFlags & 0x4) {
			flags = view.getUint32(field);
			field += 4;
		}
		if (trunFlags & 0x100) field += 4;
		if (trunFlags & 0x200) field += 4;
		if (trunFlags & 0x400) {
			if (!(trunFlags & 0x4)) flags = view.getUint32(field);
			field += 4;
		}
		let compositionOffset = 0;
		if (trunFlags & 0x800) {
			if (field + 4 > trun.end) return null;
			compositionOffset =
				trunVersion === 1 ? view.getInt32(field) : view.getUint32(field);
		}
		point = {
			offset: moof.start,
			time: (decodeTime + compositionOffset) / info.timescale,
			keyframe: (flags & NON_SYNC_SAMPLE) === 0,
			relocatable,
		};
	}
	return point ? { ...point, relocatable } : null;
}

/// Every whole fragment in `window` (which starts at file offset
/// `windowStart`): the first `moof` is found by its signature and verified by
/// its structure and the `mdat` right after it, the rest by following box
/// sizes. `resumeAt` is where scanning should continue in the file.
export function fragmentsIn(
	window: Uint8Array,
	windowStart: number,
	info: Mp4SeekInfo,
): { points: FragmentPoint[]; resumeAt: number } {
	const view = new DataView(
		window.buffer,
		window.byteOffset,
		window.byteLength,
	);
	const points: FragmentPoint[] = [];
	let offset = Math.max(0, info.moovEnd - windowStart);
	let chained = false;
	while (offset + 16 <= window.byteLength) {
		if (
			!chained &&
			(window[offset + 4] !== 0x6d ||
				window[offset + 5] !== 0x6f ||
				window[offset + 6] !== 0x6f ||
				window[offset + 7] !== 0x66)
		) {
			offset++;
			continue;
		}
		const moof = boxAt(view, offset, window.byteLength);
		const valid =
			moof?.type === "moof" &&
			moof.end - moof.start <= MAX_MOOF_BYTES &&
			moof.end + 8 <= window.byteLength;
		const mdat =
			valid && moof ? boxAt(view, moof.end, window.byteLength) : null;
		const fragment =
			valid && moof && mdat?.type === "mdat"
				? videoFragment(view, moof, info)
				: null;
		if (!moof || !mdat || !fragment) {
			if (chained) break;
			offset++;
			continue;
		}
		points.push({
			...fragment,
			offset: windowStart + moof.start,
			end: windowStart + mdat.end,
		});
		chained = true;
		offset = mdat.end;
	}
	const last = points.at(-1);
	return {
		points,
		resumeAt: last
			? last.end
			: windowStart + Math.max(0, window.byteLength - 16),
	};
}

/// A 24-byte `mfra` holding only its `mfro`. Appended to a recording that has
/// no fragment index, it answers mediabunny's look at the last four bytes for
/// an index, which otherwise jumps to wherever those bytes point and costs a
/// round trip into the middle of the file.
export function emptyMfra() {
	const bytes = new Uint8Array(24);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 24);
	bytes.set([0x6d, 0x66, 0x72, 0x61], 4);
	view.setUint32(8, 16);
	bytes.set([0x6d, 0x66, 0x72, 0x6f], 12);
	view.setUint32(20, 24);
	return bytes;
}

export function endsWithMfro(tail: Uint8Array) {
	if (tail.byteLength < 16) return false;
	const at = tail.byteLength - 16;
	const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	return view.getUint32(at) === 16 && type4(tail, at + 4) === "mfro";
}

/// The `mfra` a file ends with, from its last bytes `tail`: how long it is,
/// and the fragments its `tfra` for `trackId` lists (null when `tail` does
/// not hold all of it). Each entry starts decoding at its fragment's first
/// sample when it points there. Null when the file ends in no `mfro`; an
/// index that can't be read or lists nothing for the track has no entries.
export function trailingMfra(tail: Uint8Array, trackId: number) {
	if (!endsWithMfro(tail)) return null;
	const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	const size = view.getUint32(tail.byteLength - 4);
	if (size < 24) return { size, entries: [] };
	if (size > tail.byteLength) return { size, entries: null };
	const mfra = boxAt(view, tail.byteLength - size, tail.byteLength);
	const boxes =
		mfra?.type === "mfra" && mfra.end === tail.byteLength
			? children(view, mfra)
			: null;
	const entries: { time: number; moof: number; first: boolean }[] = [];
	for (const tfra of boxes ?? []) {
		if (tfra.type !== "tfra" || tfra.body + 16 > tfra.end) continue;
		if (view.getUint32(tfra.body + 4) !== trackId) continue;
		const version = view.getUint8(tfra.body);
		const lengths = view.getUint32(tfra.body + 8);
		const traf = ((lengths >> 4) & 3) + 1;
		const trun = ((lengths >> 2) & 3) + 1;
		const sample = (lengths & 3) + 1;
		const count = view.getUint32(tfra.body + 12);
		const stride = (version === 1 ? 16 : 8) + traf + trun + sample;
		let at = tfra.body + 16;
		if (at + count * stride > tfra.end) return { size, entries: [] };
		const uint = (offset: number, length: number) => {
			let value = 0;
			for (let index = 0; index < length; index++)
				value = value * 256 + view.getUint8(offset + index);
			return value;
		};
		for (let index = 0; index < count; index++) {
			const wide = version === 1;
			const time = wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
			const moof = wide
				? Number(view.getBigUint64(at + 8))
				: view.getUint32(at + 4);
			at += wide ? 16 : 8;
			const first =
				uint(at + traf, trun) === 1 && uint(at + traf + trun, sample) === 1;
			at += traf + trun + sample;
			entries.push({ time, moof, first });
		}
	}
	return { size, entries };
}

/// Entry points from an `mfra`'s entries for a file whose fragments end at
/// `end`: the fragments that start with a sync sample.
export function mfraPoints(
	entries: { time: number; moof: number; first: boolean }[],
	timescale: number,
	moovEnd: number,
	end: number,
	relocatable: boolean,
): FragmentPoint[] {
	const byMoof = new Map<number, { time: number; first: boolean }>();
	for (const entry of entries) {
		const seen = byMoof.get(entry.moof);
		if (!seen || (entry.first && !seen.first)) byMoof.set(entry.moof, entry);
	}
	const sorted = [...byMoof].sort(([a], [b]) => a - b);
	const points: FragmentPoint[] = [];
	for (const [index, [moof, entry]] of sorted.entries()) {
		const next = sorted[index + 1]?.[0] ?? end;
		if (moof < moovEnd || moof >= end) return [];
		if (!entry.first) continue;
		points.push({
			offset: moof,
			time: entry.time / timescale,
			keyframe: true,
			relocatable,
			end: next,
		});
	}
	return points;
}

export type LayoutPiece =
	| {
			start: number;
			end: number;
			kind: "bytes";
			bytes: Uint8Array;
			/// The header of the second part of a WebM cluster cut in two
			/// (`webmCutLayout`), whose key frame, at this time in seconds, is in
			/// the first part.
			cutKeyTime?: number;
	  }
	| {
			start: number;
			end: number;
			kind: "remote";
			source: number;
			/// A read starting at this piece takes the source up to here at
			/// once: a WebM cluster mediabunny loads whole before it returns
			/// any of its frames.
			burstEnd?: number;
			/// Bytes past a WebM cluster cut for a decoder, played only later: a
			/// read of them waits while any cut is being read.
			deferred?: boolean;
	  };

/// Byte map of a virtual file: `init` (ftyp + moov), the recording from
/// `fromOffset` to its end, then `trailer`. With `fromOffset` at the first
/// fragment this is the whole file.
export function virtualLayout(
	init: Uint8Array | null,
	fromOffset: number,
	size: number,
	trailer: Uint8Array | null,
): LayoutPiece[] {
	const pieces: LayoutPiece[] = [];
	let at = 0;
	if (init && init.byteLength > 0) {
		pieces.push({ start: 0, end: init.byteLength, kind: "bytes", bytes: init });
		at = init.byteLength;
	}
	if (size > fromOffset) {
		pieces.push({
			start: at,
			end: at + size - fromOffset,
			kind: "remote",
			source: fromOffset,
		});
		at += size - fromOffset;
	}
	if (trailer && trailer.byteLength > 0) {
		pieces.push({
			start: at,
			end: at + trailer.byteLength,
			kind: "bytes",
			bytes: trailer,
		});
	}
	return pieces;
}

export function layoutSize(pieces: LayoutPiece[]) {
	return pieces.at(-1)?.end ?? 0;
}

/// The piece of a virtual read starting at `start`, capped at `maxLength`
/// bytes and at the piece's end.
export function planLayoutRead(
	pieces: LayoutPiece[],
	start: number,
	maxLength: number,
) {
	const piece = pieces.find(
		(entry) => entry.start <= start && start < entry.end,
	);
	if (!piece) return null;
	const end = Math.min(piece.end, start + Math.max(1, maxLength));
	return piece.kind === "bytes"
		? {
				kind: "bytes" as const,
				start,
				end,
				bytes: piece.bytes.subarray(start - piece.start, end - piece.start),
			}
		: {
				kind: "remote" as const,
				start,
				end,
				sourceStart: piece.source + (start - piece.start),
				sourceEnd: piece.source + (end - piece.start),
			};
}

/// Next step of an interpolation search for the fragment to start decoding
/// `target` from. `known` holds verified keyframe fragments sorted by
/// offset, including the first and last of the file. Done when the nearest
/// fragment at or before the target is within `nearBytes` of where the target
/// should be. A probe aims `earlyBytes` before where the target should be
/// (half of `nearBytes` unless given).
export function nextFragmentProbe(
	known: FragmentPoint[],
	target: number,
	nearBytes: number,
	earlyBytes = nearBytes / 2,
): { done: FragmentPoint | null } | { probeAt: number } {
	let before: FragmentPoint | null = null;
	let after: FragmentPoint | null = null;
	for (const point of known) {
		if (point.time <= target) {
			if (!before || point.time > before.time) before = point;
		} else if (!after || point.time < after.time) {
			after = point;
		}
	}
	if (!before) return { done: null };
	if (!after) return { done: before };
	const span = after.offset - before.offset;
	const fraction =
		after.time > before.time
			? (target - before.time) / (after.time - before.time)
			: 0;
	const estimate = before.offset + fraction * span;
	if (estimate - before.offset <= nearBytes || span <= nearBytes * 2) {
		return { done: before };
	}
	// Aim a little early: landing after the target costs another probe,
	// landing before only a short walk.
	const probeAt = Math.round(estimate - Math.min(earlyBytes, span / 8));
	return {
		probeAt: Math.max(before.end, Math.min(probeAt, after.offset - 1)),
	};
}

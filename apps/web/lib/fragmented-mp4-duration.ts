type Box = { type: string; start: number; end: number; body: number };

function boxes(view: DataView, start: number, end: number): Box[] {
	const out: Box[] = [];
	let offset = start;
	while (offset + 8 <= end) {
		let size = view.getUint32(offset);
		let body = offset + 8;
		if (size === 1) {
			if (offset + 16 > end) break;
			size = Number(view.getBigUint64(offset + 8));
			body = offset + 16;
		} else if (size === 0) {
			size = end - offset;
		}
		if (size < body - offset || offset + size > end) break;
		const type = String.fromCharCode(
			view.getUint8(offset + 4),
			view.getUint8(offset + 5),
			view.getUint8(offset + 6),
			view.getUint8(offset + 7),
		);
		out.push({ type, start: offset, end: offset + size, body });
		offset += size;
	}
	return out;
}

const child = (view: DataView, box: Box, type: string) =>
	boxes(view, box.body, box.end).find((entry) => entry.type === type);

type TrackTiming = { timescale: number; defaultDuration: number };

/// Track timescales and `trex` default sample durations from the start of a
/// fragmented MP4, or null when the bytes do not hold a complete fragmented
/// `moov`.
export function fragmentedMp4Tracks(head: Uint8Array) {
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const moov = boxes(view, 0, head.byteLength).find(
		(box) => box.type === "moov",
	);
	if (!moov) return null;
	const children = boxes(view, moov.body, moov.end);
	const mvex = children.find((box) => box.type === "mvex");
	if (!mvex) return null;
	const tracks = new Map<number, TrackTiming>();
	for (const trak of children.filter((box) => box.type === "trak")) {
		const tkhd = child(view, trak, "tkhd");
		const mdia = child(view, trak, "mdia");
		const mdhd = mdia && child(view, mdia, "mdhd");
		// Edit lists shift presentation times; leave those files to mediabunny.
		if (!tkhd || !mdhd || child(view, trak, "edts")) return null;
		const trackId = view.getUint32(
			tkhd.body + (view.getUint8(tkhd.body) === 1 ? 20 : 12),
		);
		const timescale = view.getUint32(
			mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12),
		);
		if (timescale < 1) return null;
		tracks.set(trackId, { timescale, defaultDuration: 0 });
	}
	for (const trex of boxes(view, mvex.body, mvex.end)) {
		if (trex.type !== "trex") continue;
		const track = tracks.get(view.getUint32(trex.body + 4));
		if (track) track.defaultDuration = view.getUint32(trex.body + 12);
	}
	return tracks.size > 0 ? tracks : null;
}

/// End time in seconds of the fragmented MP4 whose last bytes are `tail`: the
/// latest `tfdt` plus sample durations across the tracks of the final
/// `moof`, which must be followed by an `mdat` that runs to the end of the
/// file. Null when the tail does not contain that whole fragment.
export function fragmentedMp4End(
	tail: Uint8Array,
	tracks: Map<number, TrackTiming>,
) {
	const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	for (let offset = tail.byteLength - 16; offset >= 0; offset--) {
		if (
			view.getUint8(offset + 4) !== 0x6d ||
			view.getUint8(offset + 5) !== 0x6f ||
			view.getUint8(offset + 6) !== 0x6f ||
			view.getUint8(offset + 7) !== 0x66
		) {
			continue;
		}
		const [moof, mdat, ...rest] = boxes(view, offset, tail.byteLength);
		if (
			moof?.type !== "moof" ||
			mdat?.type !== "mdat" ||
			rest.length > 0 ||
			mdat.end !== tail.byteLength
		) {
			continue;
		}
		let end: number | null = null;
		for (const traf of boxes(view, moof.body, moof.end)) {
			if (traf.type !== "traf") continue;
			const trafEnd = trackFragmentEnd(view, traf, tracks);
			if (trafEnd === null) return null;
			end = Math.max(end ?? 0, trafEnd);
		}
		return end;
	}
	return null;
}

function trackFragmentEnd(
	view: DataView,
	traf: Box,
	tracks: Map<number, TrackTiming>,
) {
	const children = boxes(view, traf.body, traf.end);
	const tfhd = children.find((box) => box.type === "tfhd");
	const tfdt = children.find((box) => box.type === "tfdt");
	if (!tfhd || !tfdt) return null;
	const track = tracks.get(view.getUint32(tfhd.body + 4));
	if (!track) return null;
	const tfhdFlags = view.getUint32(tfhd.body) & 0xffffff;
	let defaultDuration = track.defaultDuration;
	if (tfhdFlags & 0x8) {
		let field = tfhd.body + 8;
		if (tfhdFlags & 0x1) field += 8;
		if (tfhdFlags & 0x2) field += 4;
		defaultDuration = view.getUint32(field);
	}
	let decodeTime =
		view.getUint8(tfdt.body) === 1
			? Number(view.getBigUint64(tfdt.body + 4))
			: view.getUint32(tfdt.body + 4);
	let end = decodeTime;
	for (const trun of children.filter((box) => box.type === "trun")) {
		const version = view.getUint8(trun.body);
		const flags = view.getUint32(trun.body) & 0xffffff;
		const count = view.getUint32(trun.body + 4);
		let field = trun.body + 8;
		if (flags & 0x1) field += 4;
		if (flags & 0x4) field += 4;
		const hasDuration = (flags & 0x100) !== 0;
		const hasSize = (flags & 0x200) !== 0;
		const hasFlags = (flags & 0x400) !== 0;
		const hasOffset = (flags & 0x800) !== 0;
		const stride = 4 * (+hasDuration + +hasSize + +hasFlags + +hasOffset);
		if (field + count * stride > trun.end) return null;
		for (let sample = 0; sample < count; sample++) {
			const at = field + sample * stride;
			const duration = hasDuration ? view.getUint32(at) : defaultDuration;
			const offsetAt = at + 4 * (+hasDuration + +hasSize + +hasFlags);
			const offset = hasOffset
				? version === 1
					? view.getInt32(offsetAt)
					: view.getUint32(offsetAt)
				: 0;
			end = Math.max(end, decodeTime + offset + duration);
			decodeTime += duration;
		}
	}
	return end / track.timescale;
}

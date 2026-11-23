import { type Box, boxAt, children } from "./fragmented-mp4-seek";

export type ByteRange = { start: number; end: number };

function child(view: DataView, parent: Box, type: string) {
	return children(view, parent)?.find((box) => box.type === type) ?? null;
}

function path(view: DataView, parent: Box, ...types: string[]) {
	let box: Box | null = parent;
	for (const type of types) {
		if (!box) return null;
		box = child(view, box, type);
	}
	return box;
}

function handler(view: DataView, trak: Box) {
	const hdlr = path(view, trak, "mdia", "hdlr");
	if (!hdlr || hdlr.body + 12 > hdlr.end) return null;
	return String.fromCharCode(
		...new Uint8Array(view.buffer, view.byteOffset + hdlr.body + 8, 4),
	);
}

/// Byte ranges of every chunk of a track, from its sample table.
function chunkRanges(view: DataView, stbl: Box): ByteRange[] | null {
	const stsc = child(view, stbl, "stsc");
	const stsz = child(view, stbl, "stsz");
	const stco = child(view, stbl, "stco") ?? child(view, stbl, "co64");
	if (!stsc || !stsz || !stco) return null;
	const wide = stco.type === "co64";
	const chunkCount = view.getUint32(stco.body + 4);
	const offsetsAt = stco.body + 8;
	if (offsetsAt + chunkCount * (wide ? 8 : 4) > stco.end) return null;
	const fixedSize = view.getUint32(stsz.body + 4);
	const sampleCount = view.getUint32(stsz.body + 8);
	const sizesAt = stsz.body + 12;
	if (fixedSize === 0 && sizesAt + sampleCount * 4 > stsz.end) return null;
	const runCount = view.getUint32(stsc.body + 4);
	const runsAt = stsc.body + 8;
	if (runsAt + runCount * 12 > stsc.end || runCount === 0) return null;

	const ranges: ByteRange[] = [];
	let sample = 0;
	for (let run = 0; run < runCount; run++) {
		const firstChunk = view.getUint32(runsAt + run * 12);
		const perChunk = view.getUint32(runsAt + run * 12 + 4);
		const nextFirst =
			run + 1 < runCount
				? view.getUint32(runsAt + (run + 1) * 12)
				: chunkCount + 1;
		if (firstChunk < 1 || nextFirst < firstChunk) return null;
		for (let chunk = firstChunk; chunk < nextFirst; chunk++) {
			if (chunk > chunkCount) return null;
			const offset = wide
				? Number(view.getBigUint64(offsetsAt + (chunk - 1) * 8))
				: view.getUint32(offsetsAt + (chunk - 1) * 4);
			let bytes = 0;
			for (let index = 0; index < perChunk; index++, sample++) {
				if (sample >= sampleCount) return null;
				bytes +=
					fixedSize !== 0 ? fixedSize : view.getUint32(sizesAt + sample * 4);
			}
			if (bytes > 0) ranges.push({ start: offset, end: offset + bytes });
		}
	}
	return ranges;
}

export type Mp4AudioLayout = {
	/// Every chunk of the first audio track, in file order.
	chunks: ByteRange[];
	hasVideo: boolean;
};

/// Where the first audio track's samples sit in a non-fragmented MP4, from its
/// `moov` box, so its audio can be read without the video around it.
export function mp4AudioLayout(moov: Uint8Array): Mp4AudioLayout | null {
	try {
		return audioLayout(moov);
	} catch {
		return null;
	}
}

function audioLayout(moov: Uint8Array): Mp4AudioLayout | null {
	const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
	const root = boxAt(view, 0, moov.byteLength);
	if (!root || root.type !== "moov" || root.end > moov.byteLength) return null;
	const traks = children(view, root)?.filter((box) => box.type === "trak");
	if (!traks) return null;
	if (children(view, root)?.some((box) => box.type === "mvex")) return null;
	let hasVideo = false;
	let audio: Box | null = null;
	for (const trak of traks) {
		const kind = handler(view, trak);
		if (kind === "vide") hasVideo = true;
		if (kind === "soun" && !audio) audio = trak;
	}
	if (!audio) return null;
	const stbl = path(view, audio, "mdia", "minf", "stbl");
	const chunks = stbl ? chunkRanges(view, stbl) : null;
	if (!chunks) return null;
	chunks.sort((a, b) => a.start - b.start);
	return { chunks, hasVideo };
}

/// Merges ranges closer than `gap` bytes, so neighbouring chunks come in one
/// request.
export function coalesceRanges(ranges: ByteRange[], gap: number) {
	const out: ByteRange[] = [];
	for (const range of ranges) {
		const last = out[out.length - 1];
		if (last && range.start - last.end <= gap)
			last.end = Math.max(last.end, range.end);
		else out.push({ ...range });
	}
	return out;
}

/// Assumed link for choosing a read plan: a round trip per request shared
/// across the requests in flight, then bandwidth.
const SECONDS_PER_REQUEST = 0.01;
const BYTES_PER_SECOND = 6_250_000;
const COALESCE_GAP = 64 * 1024;

/// The ranges to read for the first audio track of a video file when that is
/// well under half the cost of reading the whole file, else null.
export function sparseAudioPlan(moov: Uint8Array, fileSize: number) {
	const layout = mp4AudioLayout(moov);
	if (!layout?.hasVideo || layout.chunks.length === 0) return null;
	const plan = coalesceRanges(layout.chunks, COALESCE_GAP);
	const bytes = plan.reduce((sum, range) => sum + range.end - range.start, 0);
	const sparse = plan.length * SECONDS_PER_REQUEST + bytes / BYTES_PER_SECOND;
	const whole = fileSize / BYTES_PER_SECOND;
	return sparse < whole / 2 ? plan : null;
}

import type { FragmentPoint, LayoutPiece } from "./fragmented-mp4-seek";

/// Byte-level helpers for starting playback of a long WebM recording part-way
/// through. MediaRecorder writes no Cues, so a media element or demuxer finds
/// a time by reading every cluster before it; here a cluster near the target
/// is found from the Cues the recorder appends, or from a few small reads
/// without them, and read from there.

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const TIMECODE_SCALE = 0x2ad7b1;
const CLUSTER = 0x1f43b675;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const POSITION = 0xa7;
const PREV_SIZE = 0xab;
const BLOCK = 0xa1;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CUES = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;
const VIDEO_TRACK = 1;
const KEY_FRAME = 0x80;
const UNKNOWN_SIZE = -1;
/// Clusters from a recorder hold seconds of audio; anything claiming more is
/// not a cluster header.
const MAX_CLUSTER_BYTES = 64 * 1024 * 1024;

function vint(bytes: Uint8Array, offset: number, keepMarker: boolean) {
	const first = bytes[offset];
	if (first === undefined || first === 0) return null;
	const length = Math.clz32(first) - 23;
	if (offset + length > bytes.length) return null;
	let value = keepMarker ? first : first & (0xff >> length);
	let allOnes = value === 0xff >> length;
	for (let index = 1; index < length; index++) {
		const byte = bytes[offset + index] ?? 0;
		value = value * 256 + byte;
		allOnes &&= byte === 0xff;
	}
	return { value: !keepMarker && allOnes ? UNKNOWN_SIZE : value, length };
}

function element(bytes: Uint8Array, offset: number) {
	const id = vint(bytes, offset, true);
	const size = id && vint(bytes, offset + id.length, false);
	if (!id || !size) return null;
	const body = offset + id.length + size.length;
	return {
		id: id.value,
		body,
		size: size.value,
		end: size.value === UNKNOWN_SIZE ? null : body + size.value,
	};
}

function unsigned(bytes: Uint8Array, start: number, end: number) {
	let value = 0;
	for (let index = start; index < end; index++) {
		value = value * 256 + (bytes[index] ?? 0);
	}
	return value;
}

export type WebmSeekInfo = {
	/// Offset of the first cluster: everything before it (EBML header,
	/// segment header, info, tracks) is the init segment a decoder needs.
	initEnd: number;
	/// Offset of the Segment's body, which cue positions count from.
	segmentBody: number;
	timecodeScale: number;
	/// Track numbers of the video tracks: a cluster is an entry point only when
	/// its first video block is a key frame.
	videoTracks: number[];
	/// The segment's size is unknown, as a file written while recording has,
	/// which also has no Cues.
	live: boolean;
};

function videoTracksIn(bytes: Uint8Array, body: number, end: number) {
	const out: number[] = [];
	for (let entry = body; entry < end; ) {
		const track = element(bytes, entry);
		if (!track || track.end === null || track.end > end) return null;
		if (track.id === TRACK_ENTRY) {
			let number = 0;
			let type = 0;
			for (let field = track.body; field < track.end; ) {
				const value = element(bytes, field);
				if (!value || value.end === null || value.end > track.end) return null;
				if (value.id === TRACK_NUMBER)
					number = unsigned(bytes, value.body, value.end);
				if (value.id === TRACK_TYPE)
					type = unsigned(bytes, value.body, value.end);
				field = value.end;
			}
			if (type === VIDEO_TRACK && number > 0) out.push(number);
		}
		entry = track.end;
	}
	return out;
}

/// The init segment's extent and timecode scale from the start of a WebM, or
/// null when the head does not reach a cluster after the track headers.
export function webmSeekInfo(head: Uint8Array): WebmSeekInfo | null {
	const header = element(head, 0);
	if (header?.id !== EBML || header.end === null) return null;
	const segment = element(head, header.end);
	if (segment?.id !== SEGMENT) return null;
	let position = segment.body;
	let timecodeScale = 1_000_000;
	let videoTracks: number[] | null = null;
	while (position < head.length) {
		const child = element(head, position);
		if (!child) return null;
		if (child.id === CLUSTER) {
			return videoTracks
				? {
						initEnd: position,
						segmentBody: segment.body,
						timecodeScale,
						videoTracks,
						live: segment.end === null,
					}
				: null;
		}
		if (child.end === null || child.end > head.length) return null;
		if (child.id === TRACKS) {
			videoTracks = videoTracksIn(head, child.body, child.end);
			if (!videoTracks) return null;
		}
		if (child.id === INFO) {
			let field = child.body;
			while (field < child.end) {
				const entry = element(head, field);
				if (!entry || entry.end === null || entry.end > child.end) return null;
				if (entry.id === TIMECODE_SCALE) {
					timecodeScale =
						unsigned(head, entry.body, entry.end) || timecodeScale;
				}
				field = entry.end;
			}
		}
		position = child.end;
	}
	return null;
}

function clusterAt(
	window: Uint8Array,
	offset: number,
	secondsPerTick: number,
	videoTracks: number[],
): {
	time: number;
	end: number | null;
	header: number;
	keyframe: boolean;
} | null {
	const cluster = element(window, offset);
	if (
		cluster?.id !== CLUSTER ||
		(cluster.size !== UNKNOWN_SIZE && cluster.size > MAX_CLUSTER_BYTES)
	) {
		return null;
	}
	let position = cluster.body;
	let time: number | null = null;
	for (let child = 0; child < 4; child++) {
		const entry = element(window, position);
		if (!entry || entry.end === null) return null;
		const isBlock = entry.id === SIMPLE_BLOCK || entry.id === BLOCK_GROUP;
		// A video key frame block runs on past a short window; its header
		// (track, timecode, flags) is all a cluster's check needs.
		if (!isBlock && entry.end > window.length) return null;
		if (entry.id === TIMECODE) {
			if (entry.size < 1 || entry.size > 8) return null;
			time = unsigned(window, entry.body, entry.end);
		} else if (entry.id === SIMPLE_BLOCK || entry.id === BLOCK_GROUP) {
			if (time === null) return null;
			const block =
				entry.id === SIMPLE_BLOCK ? entry : element(window, entry.body);
			if (!block || (entry.id === BLOCK_GROUP && block.id !== BLOCK)) {
				return null;
			}
			const track = vint(window, block.body, false);
			if (!track || track.value < 1 || track.value > 127) return null;
			if (block.body + track.length + 3 > window.length) return null;
			return {
				time: time * secondsPerTick,
				end: cluster.end,
				header: cluster.body - offset,
				keyframe:
					videoTracks.length === 0 ||
					firstVideoBlockIsKey(window, position, cluster.end, videoTracks),
			};
		} else if (entry.id !== POSITION && entry.id !== PREV_SIZE) {
			return null;
		}
		position = entry.end;
	}
	return null;
}

/// Whether the first video block from `position` in a cluster is a key frame:
/// a SimpleBlock with its key flag set. False when none is in the bytes read.
function firstVideoBlockIsKey(
	window: Uint8Array,
	position: number,
	clusterEnd: number | null,
	videoTracks: number[],
) {
	const end = Math.min(window.length, clusterEnd ?? window.length);
	for (let at = position; at < end; ) {
		const entry = element(window, at);
		if (!entry || entry.end === null || entry.id === CLUSTER) return false;
		if (entry.id === SIMPLE_BLOCK || entry.id === BLOCK_GROUP) {
			const block =
				entry.id === SIMPLE_BLOCK ? entry : element(window, entry.body);
			const track = block && vint(window, block.body, false);
			if (!block || !track) return false;
			const flags = block.body + track.length + 2;
			if (videoTracks.includes(track.value)) {
				return (
					entry.id === SIMPLE_BLOCK &&
					flags < window.length &&
					((window[flags] ?? 0) & KEY_FRAME) !== 0
				);
			}
		}
		at = entry.end;
	}
	return false;
}

/// Clusters that start in `window` (file offset `windowStart`), each checked
/// by its structure: a cluster header, its timecode and a first block.
export function clustersIn(
	window: Uint8Array,
	windowStart: number,
	info: WebmSeekInfo,
): { points: FragmentPoint[]; resumeAt: number } {
	const points: FragmentPoint[] = [];
	const unknownEnds = new Set<number>();
	const secondsPerTick = info.timecodeScale / 1e9;
	let offset = Math.max(0, info.initEnd - windowStart);
	while (offset + 4 <= window.length) {
		if (
			window[offset] !== 0x1f ||
			window[offset + 1] !== 0x43 ||
			window[offset + 2] !== 0xb6 ||
			window[offset + 3] !== 0x75
		) {
			offset++;
			continue;
		}
		const cluster = clusterAt(window, offset, secondsPerTick, info.videoTracks);
		if (!cluster) {
			offset++;
			continue;
		}
		const start = windowStart + offset;
		if (cluster.end === null) unknownEnds.add(points.length);
		points.push({
			offset: start,
			time: cluster.time,
			keyframe: cluster.keyframe,
			relocatable: true,
			end:
				cluster.end === null
					? start + cluster.header
					: windowStart + cluster.end,
		});
		offset = cluster.end === null ? offset + cluster.header : cluster.end;
	}
	// A cluster of unknown size ends where the next one starts: its length,
	// which sizes how far a search aims and reads around a target.
	for (let index = 0; index + 1 < points.length; index++) {
		const point = points[index];
		const next = points[index + 1];
		if (point && next && unknownEnds.has(index)) point.end = next.offset;
	}
	const last = points.at(-1);
	return {
		points,
		resumeAt: last ? last.end : windowStart + Math.max(0, window.length - 16),
	};
}

const LEVEL_1 = new Set([
	CLUSTER,
	CUES,
	INFO,
	TRACKS,
	0x114d9b74,
	0x1254c367,
	0x1043a770,
	0x1941a469,
	EBML,
	SEGMENT,
]);
const UNKNOWN_SIZE_BYTES = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function clusterHeader(size: number | null, timecode?: Uint8Array) {
	const out = new Uint8Array(12 + (timecode?.byteLength ?? 0));
	out.set([0x1f, 0x43, 0xb6, 0x75]);
	if (size === null) out.set(UNKNOWN_SIZE_BYTES, 4);
	else {
		out[4] = 0x01;
		for (let index = 11, rest = size; index > 4; index--) {
			out[index] = rest % 256;
			rest = Math.floor(rest / 256);
		}
	}
	if (timecode) out.set(timecode, 12);
	return out;
}

/// A cluster split in two where a decoder that wants `time` can stop: the
/// first part ends `after` video blocks past it, so it holds the key frame,
/// every frame up to `time` and the few after that a decoder needs to show it.
/// The second part repeats the cluster's timecode, so its blocks keep their
/// times.
export type WebmClusterCut = {
	/// File offsets: the original cluster's body, the cut, and the cluster's
	/// end (null when its size is unknown).
	body: number;
	at: number;
	end: number | null;
	/// Time in seconds of the cluster's first video block, its key frame.
	keyTime: number;
	/// Headers for the two parts: the first with the size up to the cut, the
	/// second with the rest and the cluster's timecode.
	first: Uint8Array;
	second: Uint8Array;
};

export type WebmCutStep =
	| ({ kind: "cut" } & WebmClusterCut)
	/// More bytes are needed: at least up to `need` (a file offset), and the
	/// last block read starts at `parsed` with time `time`.
	| { kind: "more"; need: number; parsed: number; time: number };

/// Where to cut the cluster at the start of `bytes` (file offset `start`) for
/// a decoder that wants `time`, from as much of it as has been read. Blocks of
/// a cluster are written in time order, so everything a decoder needs up to
/// `time` comes before the cut. Null when the cluster ends before the cut, or
/// holds anything a cut would break (video out of order, an element of unknown
/// size); the cluster is then read whole as before.
export function webmClusterCut(
	bytes: Uint8Array,
	start: number,
	info: WebmSeekInfo,
	time: number,
	after: number,
): WebmCutStep | null {
	const cluster = element(bytes, 0);
	if (!cluster) {
		return bytes.byteLength < 16
			? { kind: "more", need: start + 16, parsed: start, time: -1 }
			: null;
	}
	if (cluster.id !== CLUSTER) return null;
	const secondsPerTick = info.timecodeScale / 1e9;
	let timecode: Uint8Array | null = null;
	let ticks = 0;
	let lastVideo = Number.NEGATIVE_INFINITY;
	let firstVideo: number | null = null;
	let past = 0;
	let parsed = start;
	let parsedTime = -1;
	for (let at = cluster.body; ; ) {
		if (cluster.end !== null && at >= cluster.end) return null;
		const entry = element(bytes, at);
		if (!entry) {
			if (bytes.byteLength - at < 16) {
				return {
					kind: "more",
					need: start + at + 16,
					parsed,
					time: parsedTime,
				};
			}
			return null;
		}
		if (LEVEL_1.has(entry.id)) return null;
		if (entry.end === null) return null;
		if (entry.id === TIMECODE) {
			if (entry.end > bytes.byteLength) {
				return { kind: "more", need: start + entry.end, parsed, time: -1 };
			}
			if (entry.size < 1 || entry.size > 8) return null;
			ticks = unsigned(bytes, entry.body, entry.end);
			timecode = bytes.slice(at, entry.end);
		} else if (entry.id === SIMPLE_BLOCK || entry.id === BLOCK_GROUP) {
			const block =
				entry.id === SIMPLE_BLOCK ? entry : element(bytes, entry.body);
			const track = block && vint(bytes, block.body, false);
			if (!block || !track || block.body + track.length + 3 > bytes.length) {
				return {
					kind: "more",
					need: start + at + 64,
					parsed,
					time: parsedTime,
				};
			}
			if (entry.id === BLOCK_GROUP && block.id !== BLOCK) return null;
			if (timecode === null) return null;
			const raw = unsigned(
				bytes,
				block.body + track.length,
				block.body + track.length + 2,
			);
			const blockTime =
				(ticks + (raw >= 0x8000 ? raw - 0x10000 : raw)) * secondsPerTick;
			parsed = start + at;
			parsedTime = blockTime;
			if (info.videoTracks.includes(track.value)) {
				if (blockTime < lastVideo) return null;
				lastVideo = blockTime;
				firstVideo ??= blockTime;
				if (blockTime > Math.max(time, firstVideo) + 1e-6) past++;
				if (past >= after) {
					if (entry.end > bytes.byteLength) {
						return {
							kind: "more",
							need: start + entry.end,
							parsed,
							time: parsedTime,
						};
					}
					const body = start + cluster.body;
					const cut = start + entry.end;
					const end = cluster.end === null ? null : start + cluster.end;
					return {
						kind: "cut",
						body,
						at: cut,
						end,
						keyTime: firstVideo ?? blockTime,
						first: clusterHeader(cut - body),
						second: clusterHeader(
							end === null ? null : end - cut + timecode.byteLength,
							timecode,
						),
					};
				}
			}
		}
		at = entry.end;
	}
}

/// Byte map of a virtual file that reads the cluster at `clusterOffset` cut
/// in two: `init` (or the file's own bytes before the cluster when null), the
/// first part, then the second and the recording on to `end`. A read of the
/// second part takes the rest of the cluster at once when `clusterEnd` is
/// known.
export function webmCutLayout(
	init: Uint8Array | null,
	clusterOffset: number,
	cut: WebmClusterCut,
	end: number,
	clusterEnd: number | null,
): LayoutPiece[] {
	const pieces: LayoutPiece[] = [];
	let at = 0;
	const bytes = (value: Uint8Array, cutKeyTime?: number) => {
		pieces.push({
			start: at,
			end: at + value.byteLength,
			kind: "bytes",
			bytes: value,
			...(cutKeyTime === undefined ? {} : { cutKeyTime }),
		});
		at += value.byteLength;
	};
	const remote = (source: number, stop: number, played?: number | null) => {
		if (stop <= source) return;
		pieces.push({
			start: at,
			end: at + stop - source,
			kind: "remote",
			source,
			...(played === undefined
				? {}
				: { deferred: true, ...(played === null ? {} : { burstEnd: played }) }),
		});
		at += stop - source;
	};
	if (init) bytes(init);
	else remote(0, clusterOffset);
	bytes(cut.first);
	remote(cut.body, cut.at);
	bytes(cut.second, cut.keyTime);
	remote(cut.at, end, clusterEnd);
	return pieces;
}

/// Last bytes of a WebM the recorder indexed: a Void element whose body is
/// "cues", each track's last block timecode (track number, eight bytes), how
/// many tracks it lists, and the length of the Cues element just before it. A
/// file written while recording has no SeekHead to point at Cues, so this is
/// how a reader of the file's end finds them, and its end without reading its
/// last cluster.
function cuesTrailer(tail: Uint8Array) {
	const tracks = tail[tail.length - 9];
	if (tracks === undefined || tracks > 8) return null;
	const body = 13 + 9 * tracks;
	const at = tail.length - body - 2;
	if (
		at < 0 ||
		tail[at] !== 0xec ||
		tail[at + 1] !== (0x80 | body) ||
		tail[at + 2] !== 0x63 ||
		tail[at + 3] !== 0x75 ||
		tail[at + 4] !== 0x65 ||
		tail[at + 5] !== 0x73
	)
		return null;
	const ends = new Map<number, number>();
	for (let index = 0; index < tracks; index++) {
		const entry = at + 6 + index * 9;
		ends.set(tail[entry] ?? 0, unsigned(tail, entry + 1, entry + 9));
	}
	return {
		bytes: body + 2,
		cuesLength: unsigned(tail, tail.length - 8, tail.length),
		ends,
	};
}

/// Where the Cues that end a WebM of `size` bytes start, from its last bytes
/// `tail`, or null when it ends in no recorder Cues.
function cuesStart(tail: Uint8Array, size: number) {
	const trailer = cuesTrailer(tail);
	return trailer ? size - trailer.bytes - trailer.cuesLength : null;
}

/// Each track's last block timecode from the recorder's trailer at the end of
/// `tail`, or null when the file has none or it lists no track.
export function webmTrailerEnds(tail: Uint8Array) {
	const ends = cuesTrailer(tail)?.ends;
	return ends && ends.size > 0 ? ends : null;
}

/// `tail` without the Cues and trailer the recorder appends, or an empty
/// array when `tail` does not reach back to where they start.
export function webmWithoutCues(tail: Uint8Array) {
	const start = cuesStart(tail, tail.length);
	if (start === null) return tail;
	return tail.subarray(0, Math.max(0, start));
}

/// The recorder's Cues from a WebM's last bytes `tail` (file offset
/// `tailStart`, `size` bytes in all): where they start, and the key frame
/// clusters they list (null when `tail` does not hold them all, empty when
/// they can't be read). Null when the file ends in none.
export function webmTrailingCues(
	tail: Uint8Array,
	tailStart: number,
	size: number,
	info: WebmSeekInfo,
): { start: number; points: FragmentPoint[] | null } | null {
	const start = cuesStart(tail, size);
	if (start === null || start < info.initEnd) return null;
	if (start < tailStart) return { start, points: null };
	const end = tail.length - (cuesTrailer(tail)?.bytes ?? 0);
	const cues = element(tail, start - tailStart);
	if (cues?.id !== CUES || cues.end !== end) return { start, points: [] };
	const track = info.videoTracks[0] ?? null;
	const secondsPerTick = info.timecodeScale / 1e9;
	const found: { time: number; offset: number }[] = [];
	for (let at = cues.body; at < end; ) {
		const point = element(tail, at);
		if (point?.id !== CUE_POINT || point.end === null || point.end > end)
			return { start, points: [] };
		let time: number | null = null;
		let offset: number | null = null;
		for (let field = point.body; field < point.end; ) {
			const entry = element(tail, field);
			if (!entry || entry.end === null || entry.end > point.end)
				return { start, points: [] };
			if (entry.id === CUE_TIME) time = unsigned(tail, entry.body, entry.end);
			if (entry.id === CUE_TRACK_POSITIONS) {
				let cueTrack: number | null = null;
				let cluster: number | null = null;
				for (let inner = entry.body; inner < entry.end; ) {
					const value = element(tail, inner);
					if (!value || value.end === null || value.end > entry.end)
						return { start, points: [] };
					if (value.id === CUE_TRACK)
						cueTrack = unsigned(tail, value.body, value.end);
					if (value.id === CUE_CLUSTER_POSITION)
						cluster = unsigned(tail, value.body, value.end);
					inner = value.end;
				}
				if (cluster !== null && (track === null || cueTrack === track))
					offset = info.segmentBody + cluster;
			}
			field = entry.end;
		}
		if (time !== null && offset !== null) found.push({ time, offset });
		at = point.end;
	}
	const points: FragmentPoint[] = [];
	for (const [index, cue] of found.entries()) {
		const next = found[index + 1]?.offset ?? start;
		if (cue.offset < info.initEnd || next <= cue.offset)
			return { start, points: [] };
		points.push({
			offset: cue.offset,
			time: cue.time * secondsPerTick,
			keyframe: true,
			relocatable: true,
			end: next,
		});
	}
	return { start, points };
}

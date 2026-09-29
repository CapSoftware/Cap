import type { FragmentPoint } from "./fragmented-mp4-seek";

/// Byte-level helpers for starting playback of a long WebM audio recording
/// part-way through. MediaRecorder writes no Cues, so a media element finds a
/// time by reading every cluster before it; here a cluster near the target is
/// found from a few small reads and streamed from there.

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
	timecodeScale: number;
};

/// The init segment's extent and timecode scale from the start of a WebM, or
/// null when the head does not reach a cluster after the track headers.
export function webmSeekInfo(head: Uint8Array): WebmSeekInfo | null {
	const header = element(head, 0);
	if (header?.id !== EBML || header.end === null) return null;
	const segment = element(head, header.end);
	if (segment?.id !== SEGMENT) return null;
	let position = segment.body;
	let timecodeScale = 1_000_000;
	let sawTracks = false;
	while (position < head.length) {
		const child = element(head, position);
		if (!child) return null;
		if (child.id === CLUSTER) {
			return sawTracks ? { initEnd: position, timecodeScale } : null;
		}
		if (child.end === null || child.end > head.length) return null;
		if (child.id === TRACKS) sawTracks = true;
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
): { time: number; end: number | null; header: number } | null {
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
		if (!entry || entry.end === null || entry.end > window.length) return null;
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
			return {
				time: time * secondsPerTick,
				end: cluster.end,
				header: cluster.body - offset,
			};
		} else if (entry.id !== POSITION && entry.id !== PREV_SIZE) {
			return null;
		}
		position = entry.end;
	}
	return null;
}

/// Clusters that start in `window` (file offset `windowStart`), each checked
/// by its structure: a cluster header, its timecode and a first block.
export function clustersIn(
	window: Uint8Array,
	windowStart: number,
	info: WebmSeekInfo,
): { points: FragmentPoint[]; resumeAt: number } {
	const points: FragmentPoint[] = [];
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
		const cluster = clusterAt(window, offset, secondsPerTick);
		if (!cluster) {
			offset++;
			continue;
		}
		const start = windowStart + offset;
		points.push({
			offset: start,
			time: cluster.time,
			keyframe: true,
			relocatable: true,
			end:
				cluster.end === null
					? start + cluster.header
					: windowStart + cluster.end,
		});
		offset = cluster.end === null ? offset + cluster.header : cluster.end;
	}
	const last = points.at(-1);
	return {
		points,
		resumeAt: last ? last.end : windowStart + Math.max(0, window.length - 16),
	};
}
